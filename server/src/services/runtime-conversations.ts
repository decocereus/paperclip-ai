import fs from "node:fs";
import type { IssueConversationItem, IssueConversationSnapshot, IssueRuntimeLink } from "@paperclipai/shared";
import type { CodexThreadSummary } from "@paperclipai/shared/runtime-sources";
import { readConfigFile } from "../config-file.js";
import { readOpenClawSessions } from "@paperclipai/shared/runtime-sources";
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

export function parseOpenClawSessionJsonl(content: string, limit = 100): IssueConversationItem[] {
  const items: IssueConversationItem[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type !== "message") continue;
    const message =
      typeof parsed.message === "object" && parsed.message !== null && !Array.isArray(parsed.message)
        ? parsed.message as Record<string, unknown>
        : null;
    if (!message) continue;
    const roleRaw = typeof message.role === "string" ? message.role : "system";
    const contentArray = Array.isArray(message.content)
      ? message.content.filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && !Array.isArray(item),
        )
      : [];
    const text = mapOpenClawContentText(contentArray);
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
      id: typeof parsed.id === "string" ? parsed.id : `${items.length + 1}`,
      role,
      text,
      createdAt: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      source: "openclaw",
      rawType: roleRaw,
    });
  }
  return items.slice(-Math.max(1, limit));
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
            ? ((block as Record<string, unknown>).text as string).trim()
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
        items.push({
          id: typeof item.id === "string" ? item.id : `${items.length + 1}`,
          role: "assistant",
          text,
          createdAt: null,
          source: "codex",
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
        pendingApprovals: [],
        items: [],
        error: "OpenClaw runtime source is not configured.",
      };
    }

    const [session] = readOpenClawSessions(homeDir, 500).filter(
      (entry) => entry.sessionKey === input.runtimeLink?.externalConversationId,
    );
    if (!session?.sessionFile || !fs.existsSync(session.sessionFile)) {
      return {
        issueId: input.issueId,
        runtimeLink: input.runtimeLink,
        sourceStatus: "source_unavailable",
        activeTurnId: null,
        isStreaming: false,
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
      pendingApprovals: [],
      items: parseOpenClawSessionJsonl(fs.readFileSync(session.sessionFile, "utf8"), limit),
      error: null,
    };
  } catch (error) {
    return {
      issueId: input.issueId,
      runtimeLink: input.runtimeLink,
      sourceStatus: "error",
      activeTurnId: null,
      isStreaming: false,
      pendingApprovals: [],
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
