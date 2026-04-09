import { spawn } from "node:child_process";
import type {
  IssueConversationItem,
  IssueConversationPendingApproval,
  IssueConversationSnapshot,
  IssueRuntimeLink,
} from "@paperclipai/shared";
import { extractPaperclipActions, mapCodexThreadReadResult } from "./runtime-conversations.js";
import { logger } from "../middleware/logger.js";

type Json = Record<string, unknown>;

type PendingRequest = {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type EphemeralItem = IssueConversationItem;

function codexRpcErrorMessage(method: string, response: Json): string {
  const error =
    typeof response.error === "object" && response.error !== null
      ? (response.error as Json)
      : null;
  const message =
    typeof error?.message === "string"
      ? error.message
      : `codex app-server error on ${method}`;
  const code = typeof error?.code === "number" ? ` (${error.code})` : "";
  return `${message}${code}`;
}

function isUnmaterializedThreadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /not materialized yet|includeTurns is unavailable before first user message/i.test(error.message);
}

function isPaperclipBridgeCommand(command: string | null): boolean {
  if (!command) return false;
  return (
    /\bpaperclipai\s+api\b/i.test(command) ||
    /paperclip-agent-bridge(?:\.(?:mjs|sh))?\b/i.test(command)
  );
}

function isPaperclipControlPlaneCommand(command: string | null): boolean {
  if (!command) return false;
  if (isPaperclipBridgeCommand(command)) return true;
  if (!/\bcurl\b/i.test(command)) return false;
  if (/\$PAPERCLIP_API_URL\/api\//.test(command)) return true;
  if (/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/api\//i.test(command)) return true;
  return false;
}

function preferredApprovalDecision(availableDecisions: string[]): string | null {
  if (availableDecisions.includes("acceptForSession")) return "acceptForSession";
  if (availableDecisions.includes("accept")) return "accept";
  return availableDecisions.find((value) => value === "accept" || value === "acceptForSession") ?? null;
}

function sanitizeLiveAgentMessage(text: string): {
  text: string;
  metadataJson: Record<string, unknown> | null;
} {
  const parsed = extractPaperclipActions(text);
  const withoutOpenActionBlock = parsed.cleanText.replace(/\[\[paperclip-action\]\][\s\S]*$/i, "").trim();
  return {
    text: withoutOpenActionBlock,
    metadataJson: parsed.actions.length > 0 ? { paperclipActions: parsed.actions } : null,
  };
}

class CodexLiveConversationSession {
  private proc;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private resumed = false;
  private threadId: string | null;
  private activeTurnId: string | null = null;
  private pendingApprovals = new Map<string, IssueConversationPendingApproval>();
  private ephemeralItems = new Map<string, EphemeralItem>();
  private agentMessageBuffers = new Map<string, string>();
  private reasoningBuffers = new Map<string, string>();
  private readinessPromise: Promise<void> | null = null;
  private readonly log;

  constructor(
    private readonly issueId: string,
    threadId: string | null,
    private readonly codexHome: string,
    private readonly paperclipEnv?: Record<string, string>,
    private readonly startInput?: { cwd?: string | null; name?: string | null; model?: string | null },
  ) {
    this.threadId = threadId;
    this.log = logger.child({
      service: "codex-live-conversation",
      issueId,
      threadId: threadId ?? "__pending__",
    });
    this.proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(paperclipEnv ?? {}), CODEX_HOME: codexHome },
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.proc.on("exit", () => {
      this.log.warn({
        step: "app-server-exit",
        stderr: this.stderr.trim() || null,
      }, "codex app-server exited");
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(this.stderr.trim() || "codex app-server closed unexpectedly"));
      }
      this.pending.clear();
    });
    this.proc.on("error", (err: Error) => {
      this.log.error({ step: "app-server-error", err }, "codex app-server errored");
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(err);
      }
      this.pending.clear();
    });
  }

  private onStdout(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let parsed: Json;
      try {
        parsed = JSON.parse(line) as Json;
      } catch {
        continue;
      }

      const hasMethod = typeof parsed.method === "string";
      const id = typeof parsed.id === "number" ? parsed.id : null;
      if (hasMethod && id != null && parsed.result === undefined && parsed.error === undefined) {
        this.onServerRequest(parsed);
        continue;
      }
      if (id != null) {
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (parsed.error !== undefined) {
          pending.reject(new Error(codexRpcErrorMessage("request", parsed)));
          continue;
        }
        pending.resolve(parsed);
        continue;
      }
      if (hasMethod) {
        this.onNotification(parsed.method as string, (parsed.params as Json | undefined) ?? {});
      }
    }
  }

  private onServerRequest(message: Json) {
    const method = message.method as string;
    const id = message.id as number;
    const params = (message.params as Json | undefined) ?? {};

    if (method === "item/commandExecution/requestApproval") {
      const requestId = String(id);
      const availableDecisions = Array.isArray(params.availableDecisions)
        ? params.availableDecisions.filter((value): value is string => typeof value === "string")
        : ["accept", "decline", "cancel"];
      const command = typeof params.command === "string" ? params.command : null;
      const autoDecision =
        isPaperclipControlPlaneCommand(command) ? preferredApprovalDecision(availableDecisions) : null;
      if (autoDecision) {
        this.log.info({
          step: "approval-auto-resolved",
          requestId,
          kind: "command",
          decision: autoDecision,
          command,
        }, "auto-resolved codex approval request");
        this.proc.stdin.write(JSON.stringify({ id, result: autoDecision }) + "\n");
        return;
      }
      this.log.info({
        step: "approval-requested",
        requestId,
        kind: "command",
        command,
        cwd: typeof params.cwd === "string" ? params.cwd : null,
        availableDecisions,
      }, "codex requested command approval");
      this.pendingApprovals.set(requestId, {
        requestId,
        approvalId: null,
        kind: "command",
        turnId: typeof params.turnId === "string" ? params.turnId : null,
        itemId: typeof params.itemId === "string" ? params.itemId : null,
        reason: typeof params.reason === "string" ? params.reason : null,
        command,
        cwd: typeof params.cwd === "string" ? params.cwd : null,
        availableDecisions,
      });
      return;
    }

    if (method === "item/fileChange/requestApproval") {
      const requestId = String(id);
      this.log.info({
        step: "approval-requested",
        requestId,
        kind: "file",
        cwd: typeof params.grantRoot === "string" ? params.grantRoot : null,
      }, "codex requested file approval");
      this.pendingApprovals.set(requestId, {
        requestId,
        approvalId: null,
        kind: "file",
        turnId: typeof params.turnId === "string" ? params.turnId : null,
        itemId: typeof params.itemId === "string" ? params.itemId : null,
        reason: typeof params.reason === "string" ? params.reason : null,
        command: null,
        cwd: typeof params.grantRoot === "string" ? params.grantRoot : null,
        availableDecisions: ["accept", "decline", "cancel"],
      });
      return;
    }

    // Fail-safe: decline unknown server requests so the turn does not hang forever.
    this.proc.stdin.write(JSON.stringify({ id, error: { code: -32601, message: `Unsupported request: ${method}` } }) + "\n");
  }

  private onNotification(method: string, params: Json) {
    if (method === "turn/started") {
      const turn = typeof params.turn === "object" && params.turn !== null ? (params.turn as Json) : null;
      this.activeTurnId = typeof turn?.id === "string" ? turn.id : this.activeTurnId;
      this.log.info({
        step: "turn-started",
        turnId: this.activeTurnId,
      }, "codex turn started");
      return;
    }
    if (method === "turn/completed") {
      this.log.info({
        step: "turn-completed",
        turnId: this.activeTurnId,
        pendingApprovalCount: this.pendingApprovals.size,
      }, "codex turn completed");
      this.activeTurnId = null;
      this.pendingApprovals.clear();
      return;
    }
    if (method === "item/started") {
      const item = typeof params.item === "object" && params.item !== null ? (params.item as Json) : null;
      if (!item) return;
      const itemType = typeof item.type === "string" ? item.type : "";
      const itemId = typeof item.id === "string" ? item.id : `${this.ephemeralItems.size + 1}`;
      this.log.debug({
        step: "item-started",
        turnId: this.activeTurnId,
        itemId,
        itemType,
      }, "codex item started");
      if (itemType === "agentMessage") {
        this.ephemeralItems.set(itemId, {
          id: itemId,
          role: "assistant",
          text: "",
          createdAt: null,
          source: "codex",
          kind: "message",
          rawType: itemType,
        });
        this.agentMessageBuffers.set(itemId, "");
        return;
      }
      if (itemType === "reasoning") {
        this.ephemeralItems.set(itemId, {
          id: itemId,
          role: "system",
          text: "",
          title: "Reasoning",
          createdAt: null,
          source: "codex",
          kind: "reasoning",
          status: "in_progress",
          rawType: itemType,
        });
        this.reasoningBuffers.set(itemId, "");
        return;
      }
      if (itemType === "commandExecution") {
        const command = typeof item.command === "string" ? item.command : "command";
        this.ephemeralItems.set(itemId, {
          id: itemId,
          role: "tool",
          text: `[command] ${command}`,
          title: command,
          createdAt: null,
          source: "codex",
          kind: "tool_call",
          status: "in_progress",
          rawType: itemType,
        });
        return;
      }
      if (itemType === "fileChange") {
        this.ephemeralItems.set(itemId, {
          id: itemId,
          role: "tool",
          text: "[file change]",
          title: "File change",
          createdAt: null,
          source: "codex",
          kind: "tool_call",
          status: "in_progress",
          rawType: itemType,
        });
        return;
      }
      if (itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "webSearch") {
        const title =
          typeof item.tool === "string"
            ? item.tool
            : typeof item.server === "string" && typeof item.tool === "string"
              ? `${item.server}:${item.tool}`
              : itemType;
        this.ephemeralItems.set(itemId, {
          id: itemId,
          role: "tool",
          text: "",
          title,
          createdAt: null,
          source: "codex",
          kind: "tool_call",
          status: "in_progress",
          metadataJson: item,
          rawType: itemType,
        });
      }
      return;
    }
    if (method === "item/completed") {
      const item = typeof params.item === "object" && params.item !== null ? (params.item as Json) : null;
      if (!item) return;
      const itemType = typeof item.type === "string" ? item.type : "";
      const itemId = typeof item.id === "string" ? item.id : `${this.ephemeralItems.size + 1}`;
      this.log.debug({
        step: "item-completed",
        turnId: this.activeTurnId,
        itemId,
        itemType,
        status: typeof item.status === "string" ? item.status : null,
      }, "codex item completed");
      if (itemType === "agentMessage") {
        const rawText = typeof item.text === "string" ? item.text : this.agentMessageBuffers.get(itemId) ?? "";
        const sanitized = sanitizeLiveAgentMessage(rawText);
        this.log.info({
          step: "agent-message-completed",
          turnId: this.activeTurnId,
          itemId,
          actionCount: Array.isArray(sanitized.metadataJson?.paperclipActions)
            ? sanitized.metadataJson.paperclipActions.length
            : 0,
          textPreview: sanitized.text.slice(0, 160),
        }, "codex agent message completed");
        this.ephemeralItems.set(itemId, {
          id: itemId,
          role: "assistant",
          text: sanitized.text,
          createdAt: null,
          source: "codex",
          kind: "message",
          metadataJson: sanitized.metadataJson,
          rawType: itemType,
        });
        this.agentMessageBuffers.delete(itemId);
        return;
      }
      if (itemType === "reasoning") {
        const text = this.reasoningBuffers.get(itemId) ?? "";
        this.ephemeralItems.set(itemId, {
          id: itemId,
          role: "system",
          text,
          title: "Reasoning",
          createdAt: null,
          source: "codex",
          kind: "reasoning",
          status: "completed",
          rawType: itemType,
        });
        this.reasoningBuffers.delete(itemId);
        return;
      }
      if (itemType === "commandExecution" || itemType === "fileChange" || itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "webSearch") {
        const existing = this.ephemeralItems.get(itemId);
        this.ephemeralItems.set(itemId, {
          ...(existing ?? {
            id: itemId,
            role: "tool",
            text: "",
            createdAt: null,
            source: "codex",
            kind: "tool_call",
            rawType: itemType,
          }),
          status:
            item.status === "failed"
              ? "failed"
              : "completed",
          metadataJson: item,
        });
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!itemId || !delta) return;
      const next = (this.agentMessageBuffers.get(itemId) ?? "") + delta;
      this.agentMessageBuffers.set(itemId, next);
      const sanitized = sanitizeLiveAgentMessage(next);
      this.ephemeralItems.set(itemId, {
        id: itemId,
        role: "assistant",
        text: sanitized.text,
        createdAt: null,
        source: "codex",
        kind: "message",
        metadataJson: sanitized.metadataJson,
        rawType: "agentMessage",
      });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!itemId || !delta) return;
      const next = (this.reasoningBuffers.get(itemId) ?? "") + delta;
      this.reasoningBuffers.set(itemId, next);
      this.ephemeralItems.set(itemId, {
        id: itemId,
        role: "system",
        text: next,
        title: "Reasoning",
        createdAt: null,
        source: "codex",
        kind: "reasoning",
        status: "in_progress",
        rawType: "reasoning",
      });
    }
  }

  private request(method: string, params: Json = {}, timeoutMs = 15_000): Promise<Json> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server timed out on ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(payload);
    });
  }

  private notify(method: string, params: Json = {}) {
    this.proc.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  async initialize() {
    if (this.initialized) return;
    this.log.debug({ step: "initialize" }, "initializing codex app-server session");
    await this.request("initialize", {
      clientInfo: {
        name: "paperclip",
        version: "0.0.0",
      },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  async resumeThread() {
    if (!this.threadId) return;
    if (this.resumed) return;
    this.log.debug({ step: "thread-resume", threadId: this.threadId }, "resuming codex thread");
    await this.request("thread/resume", { threadId: this.threadId });
    this.resumed = true;
  }

  async ensureThreadReady() {
    if (this.initialized && (this.threadId == null || this.resumed)) {
      return;
    }
    if (this.readinessPromise) {
      this.log.debug({
        step: "thread-ready-wait",
        threadId: this.threadId,
      }, "waiting for codex session readiness");
      await this.readinessPromise;
      return;
    }

    const readiness = (async () => {
      await this.initialize();
      if (this.threadId) {
        try {
          await this.resumeThread();
          return;
        } catch {
          this.log.warn({ step: "thread-resume-failed", threadId: this.threadId }, "failed to resume codex thread, starting a new one");
          this.threadId = null;
          this.resumed = false;
        }
      }
      if (!this.startInput) {
        throw new Error("No usable Codex thread is available for this session.");
      }
      const params: Json = {};
      if (this.startInput?.cwd) params.cwd = this.startInput.cwd;
      if (this.startInput?.model) params.model = this.startInput.model;
      params.serviceName = "paperclip";
      const response = await this.request("thread/start", params, 30_000);
      const result = typeof response.result === "object" && response.result !== null
        ? (response.result as Json)
        : {};
      const thread = typeof result.thread === "object" && result.thread !== null
        ? (result.thread as Json)
        : {};
      const threadId = typeof thread.id === "string" ? thread.id : null;
      if (!threadId) {
        throw new Error("Codex app-server did not return a thread id.");
      }
      this.threadId = threadId;
      this.resumed = true;
      this.log.info({
        step: "thread-started",
        threadId,
        cwd: this.startInput?.cwd ?? null,
        model: this.startInput?.model ?? null,
      }, "started codex thread");
      if (this.startInput?.name?.trim()) {
        await this.request("thread/name/set", { threadId, name: this.startInput.name.trim() });
      }
    })();

    const wrappedReadiness = readiness.finally(() => {
      if (this.readinessPromise === wrappedReadiness) {
        this.readinessPromise = null;
      }
    });
    this.readinessPromise = wrappedReadiness;
    await this.readinessPromise;
  }

  async readThread(includeTurns = true) {
    if (!this.threadId) return {};
    try {
      const message = await this.request("thread/read", { threadId: this.threadId, includeTurns });
      return (message.result as Json | undefined) ?? {};
    } catch (error) {
      if (includeTurns && isUnmaterializedThreadError(error)) {
        return {};
      }
      throw error;
    }
  }

  async send(inputText: string) {
    await this.ensureThreadReady();
    this.log.info({
      step: "turn-send",
      threadId: this.threadId,
      textPreview: inputText.slice(0, 160),
    }, "sending codex turn input");
    const result = await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: inputText }],
      approvalPolicy: "on-request",
    }, 30_000);
    const turn = typeof result.result === "object" && result.result !== null ? (result.result as Json).turn as Json | undefined : undefined;
    if (turn && typeof turn.id === "string") {
      this.activeTurnId = turn.id;
      return turn.id;
    }
    return null;
  }

  async steer(inputText: string) {
    if (!this.activeTurnId) throw new Error("No active turn to steer.");
    this.log.info({
      step: "turn-steer",
      threadId: this.threadId,
      turnId: this.activeTurnId,
      textPreview: inputText.slice(0, 160),
    }, "steering codex turn");
    const result = await this.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.activeTurnId,
      input: [{ type: "text", text: inputText }],
    });
    return typeof (result.result as Json | undefined)?.turnId === "string"
      ? ((result.result as Json).turnId as string)
      : this.activeTurnId;
  }

  async interrupt() {
    if (!this.activeTurnId) return null;
    const turnId = this.activeTurnId;
    this.log.info({
      step: "turn-interrupt",
      threadId: this.threadId,
      turnId,
    }, "interrupting codex turn");
    await this.request("turn/interrupt", { threadId: this.threadId, turnId });
    return turnId;
  }

  async resolveApproval(requestId: string, decision: string) {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) throw new Error("Approval request not found.");
    this.pendingApprovals.delete(requestId);
    const id = Number(requestId);
    this.log.info({
      step: "approval-resolved",
      requestId,
      decision,
      threadId: this.threadId,
    }, "resolved codex approval");
    this.proc.stdin.write(JSON.stringify({ id, result: decision }) + "\n");
  }

  async snapshot(issueId: string, runtimeLink: IssueRuntimeLink, limit = 100): Promise<IssueConversationSnapshot> {
    await this.ensureThreadReady();
    const persisted = await this.readThread(true);
    const persistedItems = mapCodexThreadReadResult(persisted, limit);
    const merged = new Map<string, IssueConversationItem>();
    for (const item of persistedItems) {
      merged.set(item.id, item);
    }
    for (const item of this.ephemeralItems.values()) {
      merged.set(item.id, item);
    }
    const items = Array.from(merged.values()).slice(-Math.max(1, limit));
    return {
      issueId,
      runtimeLink,
      sourceStatus: "ok",
      activeTurnId: this.activeTurnId,
      isStreaming: this.activeTurnId != null,
      runtimeInfo: {
        runtimeKind: "codex",
        externalConversationId: runtimeLink.externalConversationId,
        externalConversationLabel: runtimeLink.externalConversationLabel,
        model: null,
        provider: "openai",
        thinking: null,
        reasoning: "summary",
        sessionKey: null,
        metadataJson: runtimeLink.metadataJson ?? null,
      },
      pendingApprovals: Array.from(this.pendingApprovals.values()),
      items,
      error: null,
    };
  }

  getCurrentThreadId() {
    return this.threadId;
  }
}

const codexLiveSessions = new Map<string, CodexLiveConversationSession>();

function sessionKey(issueId: string, threadId: string | null, codexHome: string) {
  return `${issueId}::${threadId ?? "__pending__"}::${codexHome}`;
}

export function getOrCreateCodexLiveConversationSession(
  issueId: string,
  threadId: string | null,
  codexHome: string,
  paperclipEnv?: Record<string, string>,
  startInput?: { cwd?: string | null; name?: string | null; model?: string | null },
) {
  const key = sessionKey(issueId, threadId, codexHome);
  let session = codexLiveSessions.get(key);
  if (!session) {
    session = new CodexLiveConversationSession(issueId, threadId, codexHome, paperclipEnv, startInput);
    codexLiveSessions.set(key, session);
  }
  return session;
}

export function getExistingCodexLiveConversationSession(issueId: string, threadId: string, codexHome: string) {
  return codexLiveSessions.get(sessionKey(issueId, threadId, codexHome)) ?? null;
}
