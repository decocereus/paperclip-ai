import { spawn } from "node:child_process";
import type {
  IssueConversationItem,
  IssueConversationPendingApproval,
  IssueConversationSnapshot,
  IssueRuntimeLink,
} from "@paperclipai/shared";
import { mapCodexThreadReadResult } from "./runtime-conversations.js";

type Json = Record<string, unknown>;

type PendingRequest = {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type EphemeralItem = IssueConversationItem;

class CodexLiveConversationSession {
  private proc;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private resumed = false;
  private threadId: string;
  private activeTurnId: string | null = null;
  private pendingApprovals = new Map<string, IssueConversationPendingApproval>();
  private ephemeralItems = new Map<string, EphemeralItem>();
  private agentMessageBuffers = new Map<string, string>();

  constructor(
    private readonly issueId: string,
    threadId: string,
    private readonly codexHome: string,
  ) {
    this.threadId = threadId;
    this.proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.proc.on("exit", () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(this.stderr.trim() || "codex app-server closed unexpectedly"));
      }
      this.pending.clear();
    });
    this.proc.on("error", (err: Error) => {
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
      this.pendingApprovals.set(requestId, {
        requestId,
        approvalId: null,
        kind: "command",
        turnId: typeof params.turnId === "string" ? params.turnId : null,
        itemId: typeof params.itemId === "string" ? params.itemId : null,
        reason: typeof params.reason === "string" ? params.reason : null,
        command: typeof params.command === "string" ? params.command : null,
        cwd: typeof params.cwd === "string" ? params.cwd : null,
        availableDecisions: Array.isArray(params.availableDecisions)
          ? params.availableDecisions.filter((value): value is string => typeof value === "string")
          : ["accept", "decline", "cancel"],
      });
      return;
    }

    if (method === "item/fileChange/requestApproval") {
      const requestId = String(id);
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
      return;
    }
    if (method === "turn/completed") {
      this.activeTurnId = null;
      this.pendingApprovals.clear();
      return;
    }
    if (method === "item/started") {
      const item = typeof params.item === "object" && params.item !== null ? (params.item as Json) : null;
      if (!item) return;
      const itemType = typeof item.type === "string" ? item.type : "";
      const itemId = typeof item.id === "string" ? item.id : `${this.ephemeralItems.size + 1}`;
      if (itemType === "agentMessage") {
        this.ephemeralItems.set(itemId, {
          id: itemId,
          role: "assistant",
          text: "",
          createdAt: null,
          source: "codex",
          rawType: itemType,
        });
        this.agentMessageBuffers.set(itemId, "");
        return;
      }
      if (itemType === "commandExecution") {
        const command = typeof item.command === "string" ? item.command : "command";
        this.ephemeralItems.set(itemId, {
          id: itemId,
          role: "tool",
          text: `[command] ${command}`,
          createdAt: null,
          source: "codex",
          rawType: itemType,
        });
        return;
      }
      if (itemType === "fileChange") {
        this.ephemeralItems.set(itemId, {
          id: itemId,
          role: "tool",
          text: "[file change]",
          createdAt: null,
          source: "codex",
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
      if (itemType === "agentMessage") {
        const text = typeof item.text === "string" ? item.text : this.agentMessageBuffers.get(itemId) ?? "";
        this.ephemeralItems.set(itemId, {
          id: itemId,
          role: "assistant",
          text,
          createdAt: null,
          source: "codex",
          rawType: itemType,
        });
        this.agentMessageBuffers.delete(itemId);
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!itemId || !delta) return;
      const next = (this.agentMessageBuffers.get(itemId) ?? "") + delta;
      this.agentMessageBuffers.set(itemId, next);
      this.ephemeralItems.set(itemId, {
        id: itemId,
        role: "assistant",
        text: next,
        createdAt: null,
        source: "codex",
        rawType: "agentMessage",
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
    if (this.resumed) return;
    await this.request("thread/resume", { threadId: this.threadId });
    this.resumed = true;
  }

  async readThread(includeTurns = true) {
    const message = await this.request("thread/read", { threadId: this.threadId, includeTurns });
    return (message.result as Json | undefined) ?? {};
  }

  async send(inputText: string) {
    await this.initialize();
    await this.resumeThread();
    const result = await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: inputText }],
      approvalPolicy: "onRequest",
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
    await this.request("turn/interrupt", { threadId: this.threadId, turnId });
    return turnId;
  }

  async resolveApproval(requestId: string, decision: string) {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) throw new Error("Approval request not found.");
    this.pendingApprovals.delete(requestId);
    const id = Number(requestId);
    this.proc.stdin.write(JSON.stringify({ id, result: decision }) + "\n");
  }

  async snapshot(issueId: string, runtimeLink: IssueRuntimeLink, limit = 100): Promise<IssueConversationSnapshot> {
    await this.initialize();
    await this.resumeThread();
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
      pendingApprovals: Array.from(this.pendingApprovals.values()),
      items,
      error: null,
    };
  }
}

const codexLiveSessions = new Map<string, CodexLiveConversationSession>();

function sessionKey(issueId: string, threadId: string, codexHome: string) {
  return `${issueId}::${threadId}::${codexHome}`;
}

export function getOrCreateCodexLiveConversationSession(issueId: string, threadId: string, codexHome: string) {
  const key = sessionKey(issueId, threadId, codexHome);
  let session = codexLiveSessions.get(key);
  if (!session) {
    session = new CodexLiveConversationSession(issueId, threadId, codexHome);
    codexLiveSessions.set(key, session);
  }
  return session;
}

export function getExistingCodexLiveConversationSession(issueId: string, threadId: string, codexHome: string) {
  return codexLiveSessions.get(sessionKey(issueId, threadId, codexHome)) ?? null;
}
