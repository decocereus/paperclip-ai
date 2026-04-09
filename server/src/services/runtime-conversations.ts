import fs from "node:fs";
import type {
  IssueConversationItem,
  IssueConversationSnapshot,
  IssueRuntimeLink,
} from "@paperclipai/shared";
import type { CodexThreadSummary } from "@paperclipai/shared/runtime-sources";
import { readConfigFile } from "../config-file.js";
import {
  readOpenClawSessions,
  type OpenClawSessionSummary,
} from "@paperclipai/shared/runtime-sources";
import { spawn } from "node:child_process";

function mapOpenClawContentText(content: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const item of content) {
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "text" && typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text.trim());
      continue;
    }
    if (type === "toolCall" && typeof item.name === "string") {
      parts.push(`[tool:${item.name}]`);
      continue;
    }
  }
  return parts.join("\n\n").trim();
}

function stripPaperclipDirectAgentBootstrap(text: string): string {
  let trimmed = text.trim();

  for (const sentinel of ["paperclip-agent-chat-bootstrap", "paperclip-agent-chat-guidance"]) {
    const match = trimmed.match(
      new RegExp(`^\\[\\[${sentinel}\\]\\][\\s\\S]*?\\[\\[\\/${sentinel}\\]\\]\\s*([\\s\\S]*)$`, "i"),
    );
    if (match) {
      trimmed = (match[1] ?? "").trim();
    }
  }

  const legacySplit = trimmed.split(/\nBoard message:\n/i);
  if (trimmed.startsWith("Direct board-to-agent chat inside Paperclip.") && legacySplit.length > 1) {
    return legacySplit.slice(1).join("\nBoard message:\n").trim();
  }

  return trimmed;
}

export function extractPaperclipActions(text: string): {
  cleanText: string;
  actions: Array<Record<string, unknown>>;
} {
  const actions: Array<Record<string, unknown>> = [];
  let cleanText = text;
  const pattern = /\[\[paperclip-action\]\]([\s\S]*?)\[\[\/paperclip-action\]\]/gi;
  cleanText = cleanText.replace(pattern, (_match, payload) => {
    try {
      const parsed = JSON.parse(String(payload).trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        actions.push(parsed as Record<string, unknown>);
      }
    } catch {
      // ignore malformed action blocks
    }
    return "";
  });
  if (actions.length === 0) {
    const implicitDirectSend =
      cleanText.match(/^Sent to\s+`?@?([^`\n:]+)`?\s+directly:\s+`([^`]+)`/i) ??
      cleanText.match(/^Sent to\s+@?([^\s:]+)\s+directly:\s+(.+)$/i);
    if (implicitDirectSend) {
      const targetAgentName = implicitDirectSend[1]?.trim() ?? "";
      const body = implicitDirectSend[2]?.trim() ?? "";
      if (targetAgentName && body) {
        actions.push({
          type: "agent_conversation_send",
          targetAgentName,
          body,
        });
      }
    }
  }
  return {
    cleanText: cleanText.trim(),
    actions,
  };
}

function toOpenClawMessageEnvelope(
  parsed: Record<string, unknown>,
): { id: string | null; timestamp: string | null; message: Record<string, unknown> | null } | null {
  if (parsed.type === "message") {
    const message =
      typeof parsed.message === "object" && parsed.message !== null && !Array.isArray(parsed.message)
        ? parsed.message as Record<string, unknown>
        : null;
    return {
      id: typeof parsed.id === "string" ? parsed.id : null,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      message,
    };
  }
  if (typeof parsed.role === "string" && Array.isArray(parsed.content)) {
    return {
      id:
        typeof parsed.id === "string"
          ? parsed.id
          : typeof (parsed.__openclaw as Record<string, unknown> | undefined)?.id === "string"
            ? String((parsed.__openclaw as Record<string, unknown>).id)
            : null,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      message: parsed,
    };
  }
  return null;
}

export function normalizeOpenClawMessageText(roleRaw: string, text: string): string {
  let next = text.trim();
  if (roleRaw === "user") {
    next = stripPaperclipDirectAgentBootstrap(next);
    next = next.replace(
      /^Sender \((?:untrusted|trusted) metadata\):\s*```json[\s\S]*?```\s*/i,
      "",
    );
    next = next.replace(/^\[[^\]]+\]\s*/, "");
  }
  return next.trim();
}

type OpenClawConversationHydration = {
  items: IssueConversationItem[];
  sessionKey: string | null;
  model: string | null;
  provider: string | null;
  thinking: string | null;
  reasoning: string | null;
  metadataJson: Record<string, unknown> | null;
};

function parseOpenClawConversationHydration(
  parsedMessages: Array<Record<string, unknown>>,
  limit = 100,
): OpenClawConversationHydration {
  const items: IssueConversationItem[] = [];
  let model: string | null = null;
  let provider: string | null = null;
  let thinking: string | null = null;
  let reasoning: string | null = null;

  for (const parsed of parsedMessages) {
    const type = typeof parsed.type === "string" ? parsed.type : "";

    if (type === "model_change") {
      provider = typeof parsed.provider === "string" ? parsed.provider : provider;
      model =
        typeof parsed.modelId === "string"
          ? parsed.modelId
          : typeof parsed.model === "string"
            ? parsed.model
            : model;
      continue;
    }

    if (type === "thinking_level_change") {
      thinking =
        typeof parsed.thinkingLevel === "string"
          ? parsed.thinkingLevel
          : typeof parsed.level === "string"
            ? parsed.level
            : thinking;
      continue;
    }

    if (type === "reasoning_level_change") {
      reasoning =
        typeof parsed.reasoningLevel === "string"
          ? parsed.reasoningLevel
          : typeof parsed.level === "string"
            ? parsed.level
            : reasoning;
      continue;
    }

    if (type === "custom" && parsed.customType === "model-snapshot") {
      const data =
        typeof parsed.data === "object" && parsed.data !== null && !Array.isArray(parsed.data)
          ? (parsed.data as Record<string, unknown>)
          : null;
      provider =
        typeof data?.provider === "string"
          ? data.provider
          : typeof data?.modelProvider === "string"
            ? data.modelProvider
            : provider;
      model =
        typeof data?.modelId === "string"
          ? data.modelId
          : typeof data?.model === "string"
            ? data.model
            : model;
      reasoning =
        typeof data?.reasoningLevel === "string"
          ? data.reasoningLevel
          : reasoning;
      thinking =
        typeof data?.thinkingLevel === "string"
          ? data.thinkingLevel
          : thinking;
      continue;
    }

    const envelope = toOpenClawMessageEnvelope(parsed);
    if (!envelope) continue;
    const message = envelope.message;
    if (!message) continue;
    const roleRaw = typeof message.role === "string" ? message.role : "system";
    const contentArray = Array.isArray(message.content)
      ? message.content.filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && !Array.isArray(item),
        )
      : [];
    const text = normalizeOpenClawMessageText(roleRaw, mapOpenClawContentText(contentArray));
    if (roleRaw === "assistant") {
      provider =
        typeof message.provider === "string"
          ? message.provider
          : typeof message.modelProvider === "string"
            ? message.modelProvider
            : provider;
      model =
        typeof message.model === "string"
          ? message.model
          : typeof message.modelId === "string"
            ? message.modelId
            : model;
      if (!thinking && contentArray.some((item) => item.type === "thinking")) {
        thinking = "on";
      }
    }
    if (!text) continue;
    const role: IssueConversationItem["role"] =
      roleRaw === "user"
        ? "user"
        : roleRaw === "assistant"
          ? "assistant"
          : roleRaw === "toolResult"
            ? "tool"
            : "system";
    items.push({
      id: envelope.id ?? `${items.length + 1}`,
      role,
      text,
      createdAt: envelope.timestamp,
      source: "openclaw",
      rawType: roleRaw,
    });
  }

  return {
    items: items.slice(-Math.max(1, limit)),
    sessionKey: null,
    model,
    provider,
    thinking,
    reasoning,
    metadataJson:
      model || provider || thinking || reasoning
        ? {
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          ...(reasoning ? { reasoning } : {}),
        }
        : null,
  };
}

export function mapOpenClawSessionMessages(
  messages: Array<Record<string, unknown>>,
  limit = 100,
): IssueConversationItem[] {
  return parseOpenClawConversationHydration(messages, limit).items;
}

export function resolveOpenClawSessionSummary(
  homeDir: string,
  sessionKey: string,
  limit = 500,
): OpenClawSessionSummary | null {
  const sessions = readOpenClawSessions(homeDir, limit);
  return (
    sessions.find((entry) => entry.sessionKey === sessionKey) ??
    sessions.find((entry) => entry.sessionKey.endsWith(`:${sessionKey}`)) ??
    null
  );
}

export function parseOpenClawSessionJsonl(content: string, limit = 100): IssueConversationItem[] {
  const parsedMessages = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));

  return mapOpenClawSessionMessages(parsedMessages, limit);
}

export function readOpenClawConversationSnapshotFromHome(
  homeDir: string,
  sessionKey: string,
  limit = 100,
): OpenClawConversationHydration {
  const session = resolveOpenClawSessionSummary(homeDir, sessionKey, 500);
  if (!session?.sessionFile || !fs.existsSync(session.sessionFile)) {
    return {
      items: [],
      sessionKey: session?.sessionKey ?? null,
      model: null,
      provider: null,
      thinking: null,
      reasoning: null,
      metadataJson: null,
    };
  }
  const parsedMessages = fs.readFileSync(session.sessionFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const hydration = parseOpenClawConversationHydration(parsedMessages, limit);
  return {
    ...hydration,
    sessionKey: session.sessionKey,
  };
}

export function readOpenClawConversationFromHome(
  homeDir: string,
  sessionKey: string,
  limit = 100,
): IssueConversationItem[] {
  return readOpenClawConversationSnapshotFromHome(homeDir, sessionKey, limit).items;
}

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

class CodexRpcClient {
  private proc;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, PendingRequest>();
  private stderr = "";

  constructor(private codexHome: string) {
    this.proc = spawn("codex", ["-s", "read-only", "-a", "untrusted", "app-server"], {
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
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = typeof parsed.id === "number" ? parsed.id : null;
      if (id == null) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(parsed);
    }
  }

  private request(method: string, params: Record<string, unknown> = {}, timeoutMs = 8_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server timed out on ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(payload);
    });
  }

  private notify(method: string, params: Record<string, unknown> = {}) {
    this.proc.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "paperclip",
        version: "0.0.0",
      },
    });
    this.notify("initialized", {});
  }

  async readThread(threadId: string, includeTurns = true) {
    const message = await this.request("thread/read", { threadId, includeTurns });
    return (message.result as Record<string, unknown> | undefined) ?? {};
  }

  async listThreads(limit = 20, cwd?: string) {
    const params: Record<string, unknown> = { limit };
    if (cwd) params.cwd = cwd;
    const message = await this.request("thread/list", params);
    return ((message.result as Record<string, unknown> | undefined)?.data as Array<Record<string, unknown>> | undefined) ?? [];
  }

  async startThread(input: { cwd?: string; model?: string; serviceName?: string }) {
    const params: Record<string, unknown> = {};
    if (input.cwd) params.cwd = input.cwd;
    if (input.model) params.model = input.model;
    if (input.serviceName) params.serviceName = input.serviceName;
    const message = await this.request("thread/start", params, 15_000);
    return (message.result as Record<string, unknown> | undefined) ?? {};
  }

  async setThreadName(threadId: string, name: string) {
    await this.request("thread/name/set", { threadId, name });
  }

  async readThreadLegacy(threadId: string) {
    const message = await this.request("thread/read", { threadId, includeTurns: true });
    return (message.result as Record<string, unknown> | undefined) ?? {};
  }

  async shutdown() {
    this.proc.kill("SIGTERM");
  }
}

function summarizeCodexToolItem(item: Record<string, unknown>): string | null {
  const itemType = typeof item.type === "string" ? item.type : "";
  if (itemType === "commandExecution") {
    const command = typeof item.command === "string" ? item.command : "command";
    return `[command] ${command}`;
  }
  if (itemType === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return changes.length > 0 ? `[file change] ${changes.length} change(s)` : "[file change]";
  }
  if (itemType === "mcpToolCall") {
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    return `[tool] ${tool}`;
  }
  if (itemType === "dynamicToolCall") {
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    return `[tool] ${tool}`;
  }
  return null;
}

export function mapCodexThreadReadResult(result: Record<string, unknown>, limit = 100): IssueConversationItem[] {
  const thread =
    typeof result.thread === "object" && result.thread !== null && !Array.isArray(result.thread)
      ? result.thread as Record<string, unknown>
      : null;
  const turns = Array.isArray(thread?.turns)
    ? thread?.turns.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];

  const items: IssueConversationItem[] = [];
  for (const turn of turns) {
    const turnItems = Array.isArray(turn.items)
      ? turn.items.filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && !Array.isArray(item),
        )
      : [];
    for (const item of turnItems) {
      const itemType = typeof item.type === "string" ? item.type : "";
      if (itemType === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        for (const block of content) {
          if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
          const text = typeof (block as Record<string, unknown>).text === "string"
            ? stripPaperclipDirectAgentBootstrap(((block as Record<string, unknown>).text as string).trim())
            : "";
          if (!text) continue;
          items.push({
            id: typeof item.id === "string" ? item.id : `${items.length + 1}`,
            role: "user",
            text,
            createdAt: null,
            source: "codex",
            rawType: itemType,
          });
        }
        continue;
      }
      if (itemType === "agentMessage") {
        const text = typeof item.text === "string" ? item.text.trim() : "";
        if (!text) continue;
        const parsed = extractPaperclipActions(text);
        if (!parsed.cleanText && parsed.actions.length === 0) continue;
        items.push({
          id: typeof item.id === "string" ? item.id : `${items.length + 1}`,
          role: "assistant",
          text: parsed.cleanText,
          createdAt: null,
          source: "codex",
          metadataJson: parsed.actions.length > 0 ? { paperclipActions: parsed.actions } : null,
          rawType: itemType,
        });
        continue;
      }
      const toolSummary = summarizeCodexToolItem(item);
      if (toolSummary) {
        items.push({
          id: typeof item.id === "string" ? item.id : `${items.length + 1}`,
          role: "tool",
          text: toolSummary,
          createdAt: null,
          source: "codex",
          rawType: itemType,
        });
      }
    }
  }

  return items.slice(-Math.max(1, limit));
}

async function readCodexConversation(threadId: string, codexHome: string, limit = 100) {
  const client = new CodexRpcClient(codexHome);
  try {
    await client.initialize();
    const result = await client.readThread(threadId, true);
    return mapCodexThreadReadResult(result, limit);
  } finally {
    await client.shutdown();
  }
}

export async function listCodexThreadsViaAppServer(input: {
  codexHome: string;
  limit?: number;
  cwd?: string;
}): Promise<CodexThreadSummary[]> {
  const client = new CodexRpcClient(input.codexHome);
  try {
    await client.initialize();
    const data = await client.listThreads(input.limit ?? 20, input.cwd);
    return data
      .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : "",
        threadName: typeof entry.name === "string" ? entry.name : null,
        updatedAt:
          typeof entry.updatedAt === "number"
            ? new Date(entry.updatedAt * 1000).toISOString()
            : null,
        cwd: typeof entry.cwd === "string" ? entry.cwd : null,
      }))
      .filter((entry) => entry.id.length > 0);
  } finally {
    await client.shutdown();
  }
}

export async function startCodexThreadViaAppServer(input: {
  codexHome: string;
  cwd: string;
  name?: string | null;
  model?: string | null;
}): Promise<{ threadId: string; name: string | null }> {
  const client = new CodexRpcClient(input.codexHome);
  try {
    await client.initialize();
    const result = await client.startThread({
      cwd: input.cwd,
      model: input.model ?? undefined,
      serviceName: "paperclip",
    });
    const thread =
      typeof result.thread === "object" && result.thread !== null && !Array.isArray(result.thread)
        ? result.thread as Record<string, unknown>
        : null;
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id.");
    }
    const name = input.name?.trim() ? input.name.trim() : null;
    if (name) {
      await client.setThreadName(threadId, name);
    }
    return { threadId, name };
  } finally {
    await client.shutdown();
  }
}

export async function readIssueConversation(input: {
  issueId: string;
  runtimeLink: IssueRuntimeLink | null;
  limit?: number;
}): Promise<IssueConversationSnapshot> {
  const limit = input.limit ?? 100;
  if (!input.runtimeLink) {
    return {
      issueId: input.issueId,
      runtimeLink: null,
      sourceStatus: "unlinked",
      activeTurnId: null,
      isStreaming: false,
      runtimeInfo: null,
      pendingApprovals: [],
      items: [],
      error: null,
    };
  }

  const runtimeSources = readConfigFile()?.runtimeSources ?? null;
  try {
    if (input.runtimeLink.runtimeKind === "codex") {
      const homeDir = runtimeSources?.codex?.homeDir;
      if (!homeDir) {
      return {
        issueId: input.issueId,
        runtimeLink: input.runtimeLink,
        sourceStatus: "source_unavailable",
        activeTurnId: null,
        isStreaming: false,
        runtimeInfo: {
          runtimeKind: "codex",
          externalConversationId: input.runtimeLink.externalConversationId,
          externalConversationLabel: input.runtimeLink.externalConversationLabel,
          model: null,
          provider: "openai",
          thinking: null,
          reasoning: null,
          sessionKey: null,
          metadataJson: input.runtimeLink.metadataJson ?? null,
        },
        pendingApprovals: [],
        items: [],
        error: "Codex runtime source is not configured.",
      };
      }

      return {
        issueId: input.issueId,
        runtimeLink: input.runtimeLink,
        sourceStatus: "ok",
        activeTurnId: null,
        isStreaming: false,
        runtimeInfo: {
          runtimeKind: "codex",
          externalConversationId: input.runtimeLink.externalConversationId,
          externalConversationLabel: input.runtimeLink.externalConversationLabel,
          model: null,
          provider: "openai",
          thinking: null,
          reasoning: null,
          sessionKey: null,
          metadataJson: input.runtimeLink.metadataJson ?? null,
        },
        pendingApprovals: [],
        items: await readCodexConversation(input.runtimeLink.externalConversationId, homeDir, limit),
        error: null,
      };
    }

    const homeDir = runtimeSources?.openclaw?.homeDir;
    if (!homeDir) {
      return {
        issueId: input.issueId,
        runtimeLink: input.runtimeLink,
        sourceStatus: "source_unavailable",
        activeTurnId: null,
        isStreaming: false,
        runtimeInfo: {
          runtimeKind: "openclaw",
          externalConversationId: input.runtimeLink.externalConversationId,
          externalConversationLabel: input.runtimeLink.externalConversationLabel,
          model: null,
          provider: "openclaw",
          thinking: null,
          reasoning: null,
          sessionKey: input.runtimeLink.externalConversationId,
          metadataJson: input.runtimeLink.metadataJson ?? null,
        },
        pendingApprovals: [],
        items: [],
        error: "OpenClaw runtime source is not configured.",
      };
    }

    const openclawSnapshot = readOpenClawConversationSnapshotFromHome(
      homeDir,
      input.runtimeLink.externalConversationId,
      limit,
    );
    if (openclawSnapshot.items.length === 0) {
      return {
        issueId: input.issueId,
        runtimeLink: input.runtimeLink,
        sourceStatus: "source_unavailable",
        activeTurnId: null,
        isStreaming: false,
        runtimeInfo: {
          runtimeKind: "openclaw",
          externalConversationId: input.runtimeLink.externalConversationId,
          externalConversationLabel: input.runtimeLink.externalConversationLabel,
          model: openclawSnapshot.model,
          provider: openclawSnapshot.provider ?? "openclaw",
          thinking: openclawSnapshot.thinking,
          reasoning: openclawSnapshot.reasoning,
          sessionKey: openclawSnapshot.sessionKey ?? input.runtimeLink.externalConversationId,
          metadataJson: openclawSnapshot.metadataJson ?? input.runtimeLink.metadataJson ?? null,
        },
        pendingApprovals: [],
        items: [],
        error: "OpenClaw session file is not available.",
      };
    }

    return {
      issueId: input.issueId,
      runtimeLink: input.runtimeLink,
      sourceStatus: "ok",
      activeTurnId: null,
      isStreaming: false,
      runtimeInfo: {
        runtimeKind: "openclaw",
        externalConversationId: input.runtimeLink.externalConversationId,
        externalConversationLabel: input.runtimeLink.externalConversationLabel,
        model: openclawSnapshot.model,
        provider: openclawSnapshot.provider ?? "openclaw",
        thinking: openclawSnapshot.thinking,
        reasoning: openclawSnapshot.reasoning,
        sessionKey: openclawSnapshot.sessionKey ?? input.runtimeLink.externalConversationId,
        metadataJson: openclawSnapshot.metadataJson ?? input.runtimeLink.metadataJson ?? null,
      },
      pendingApprovals: [],
      items: openclawSnapshot.items,
      error: null,
    };
  } catch (error) {
    return {
      issueId: input.issueId,
      runtimeLink: input.runtimeLink,
      sourceStatus: "error",
      activeTurnId: null,
      isStreaming: false,
      runtimeInfo: input.runtimeLink
        ? {
          runtimeKind: input.runtimeLink.runtimeKind,
          externalConversationId: input.runtimeLink.externalConversationId,
          externalConversationLabel: input.runtimeLink.externalConversationLabel,
          model: null,
          provider: input.runtimeLink.runtimeKind === "codex" ? "openai" : "openclaw",
          thinking: null,
          reasoning: null,
          sessionKey: input.runtimeLink.runtimeKind === "openclaw" ? input.runtimeLink.externalConversationId : null,
          metadataJson: input.runtimeLink.metadataJson ?? null,
        }
        : null,
      pendingApprovals: [],
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
