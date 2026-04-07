import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  RuntimeSourceMode,
  RuntimeSourcesConfig,
} from "./config-schema.js";

export type RuntimeSourceKind = "paperclip" | "codex" | "openclaw";
export type RuntimeSourceStatus = "available" | "missing" | "error";

export interface RuntimeSourceInventory {
  paperclipInstanceCount?: number;
  paperclipCurrentInstanceId?: string | null;
  codexSessionIndexPresent?: boolean;
  codexThreadCount?: number | null;
  codexSkillsDirPresent?: boolean;
  codexSkillCount?: number | null;
  codexPluginsDirPresent?: boolean;
  codexPluginCount?: number | null;
  codexPluginCachePresent?: boolean;
  openclawSessionsIndexPresent?: boolean;
  openclawSessionCount?: number | null;
  openclawSkillsDirPresent?: boolean;
  openclawSkillCount?: number | null;
  openclawMemoryDbPresent?: boolean;
}

export interface RuntimeSourceDiscovery {
  kind: RuntimeSourceKind;
  homeDir: string;
  status: RuntimeSourceStatus;
  error: string | null;
  inventory: RuntimeSourceInventory;
}

export interface CodexThreadSummary {
  id: string;
  threadName: string | null;
  updatedAt: string | null;
  cwd?: string | null;
}

export interface OpenClawSessionSummary {
  sessionKey: string;
  sessionId: string | null;
  updatedAt: number | null;
  sessionFile: string | null;
  authProfileOverride: string | null;
  originLabel: string | null;
}

export interface RuntimeNamedEntry {
  name: string;
  path: string | null;
}

export interface RuntimeSourceLinkOverrides {
  paperclipHomeDir?: string;
  paperclipMode?: RuntimeSourceMode;
  paperclipInstanceId?: string;
  codexHomeDir?: string;
  codexMode?: RuntimeSourceMode;
  openclawHomeDir?: string;
  openclawMode?: RuntimeSourceMode;
}

function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}

export function resolvePaperclipHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PAPERCLIP_HOME?.trim();
  return raw ? resolveHomeAwarePath(raw) : path.resolve(os.homedir(), ".paperclip");
}

export function resolvePaperclipInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new Error(`Invalid PAPERCLIP_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolveCodexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CODEX_HOME?.trim();
  return raw ? resolveHomeAwarePath(raw) : path.resolve(os.homedir(), ".codex");
}

export function resolveOpenClawHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OPENCLAW_HOME?.trim();
  return raw ? resolveHomeAwarePath(raw) : path.resolve(os.homedir(), ".openclaw");
}

function pathExists(candidate: string): boolean {
  try {
    fs.accessSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function countImmediateChildrenDirectories(
  dirPath: string,
  options: { excludeNames?: string[] } = {},
): number | null {
  try {
    const exclude = new Set(options.excludeNames ?? []);
    return fs.readdirSync(dirPath, { withFileTypes: true }).filter((entry) => {
      if (exclude.has(entry.name)) return false;
      return entry.isDirectory() || entry.isSymbolicLink();
    }).length;
  } catch {
    return null;
  }
}

function countJsonlRecords(filePath: string): number | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean).length;
  } catch {
    return null;
  }
}

function countJsonObjectKeys(filePath: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    return Object.keys(raw).length;
  } catch {
    return null;
  }
}

function detectPaperclipSource(env: NodeJS.ProcessEnv): RuntimeSourceDiscovery {
  const homeDir = resolvePaperclipHomeDir(env);
  if (!pathExists(homeDir)) {
    return { kind: "paperclip", homeDir, status: "missing", error: null, inventory: {} };
  }
  if (!isDirectory(homeDir)) {
    return {
      kind: "paperclip",
      homeDir,
      status: "error",
      error: "Configured Paperclip home exists but is not a directory.",
      inventory: {},
    };
  }

  return {
    kind: "paperclip",
    homeDir,
    status: "available",
    error: null,
    inventory: {
      paperclipInstanceCount: countImmediateChildrenDirectories(path.join(homeDir, "instances")) ?? 0,
      paperclipCurrentInstanceId: resolvePaperclipInstanceId(env),
    },
  };
}

function detectCodexSource(env: NodeJS.ProcessEnv): RuntimeSourceDiscovery {
  const homeDir = resolveCodexHomeDir(env);
  if (!pathExists(homeDir)) {
    return { kind: "codex", homeDir, status: "missing", error: null, inventory: {} };
  }
  if (!isDirectory(homeDir)) {
    return {
      kind: "codex",
      homeDir,
      status: "error",
      error: "Configured Codex home exists but is not a directory.",
      inventory: {},
    };
  }

  const sessionIndexPath = path.join(homeDir, "session_index.jsonl");
  const skillsDir = path.join(homeDir, "skills");
  const pluginsDir = path.join(homeDir, "plugins");
  return {
    kind: "codex",
    homeDir,
    status: "available",
    error: null,
    inventory: {
      codexSessionIndexPresent: pathExists(sessionIndexPath),
      codexThreadCount: countJsonlRecords(sessionIndexPath),
      codexSkillsDirPresent: isDirectory(skillsDir),
      codexSkillCount: countImmediateChildrenDirectories(skillsDir),
      codexPluginsDirPresent: isDirectory(pluginsDir),
      codexPluginCount: countImmediateChildrenDirectories(pluginsDir, { excludeNames: ["cache"] }),
      codexPluginCachePresent: isDirectory(path.join(pluginsDir, "cache")),
    },
  };
}

function detectOpenClawSource(env: NodeJS.ProcessEnv): RuntimeSourceDiscovery {
  const homeDir = resolveOpenClawHomeDir(env);
  if (!pathExists(homeDir)) {
    return { kind: "openclaw", homeDir, status: "missing", error: null, inventory: {} };
  }
  if (!isDirectory(homeDir)) {
    return {
      kind: "openclaw",
      homeDir,
      status: "error",
      error: "Configured OpenClaw home exists but is not a directory.",
      inventory: {},
    };
  }

  const sessionsIndexPath = path.join(homeDir, "sessions", "sessions.json");
  const skillsDir = path.join(homeDir, "skills");
  const memoryDbPath = path.join(homeDir, "memory", "main.sqlite");
  return {
    kind: "openclaw",
    homeDir,
    status: "available",
    error: null,
    inventory: {
      openclawSessionsIndexPresent: pathExists(sessionsIndexPath),
      openclawSessionCount: countJsonObjectKeys(sessionsIndexPath),
      openclawSkillsDirPresent: isDirectory(skillsDir),
      openclawSkillCount: countImmediateChildrenDirectories(skillsDir),
      openclawMemoryDbPresent: pathExists(memoryDbPath),
    },
  };
}

export function detectRuntimeSources(env: NodeJS.ProcessEnv = process.env): RuntimeSourceDiscovery[] {
  const detectors: Array<(value: NodeJS.ProcessEnv) => RuntimeSourceDiscovery> = [
    detectPaperclipSource,
    detectCodexSource,
    detectOpenClawSource,
  ];

  return detectors.map((detect) => {
    try {
      return detect(env);
    } catch (error) {
      const kind =
        detect === detectPaperclipSource
          ? "paperclip"
          : detect === detectCodexSource
            ? "codex"
            : "openclaw";
      const homeDir =
        kind === "paperclip"
          ? resolvePaperclipHomeDir(env)
          : kind === "codex"
            ? resolveCodexHomeDir(env)
            : resolveOpenClawHomeDir(env);
      return {
        kind,
        homeDir,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        inventory: {},
      };
    }
  });
}

function hasOverrideValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined;
}

export function buildLinkedRuntimeSourcesConfig(input: {
  current: RuntimeSourcesConfig | null | undefined;
  discovered: RuntimeSourceDiscovery[];
  overrides?: RuntimeSourceLinkOverrides;
}): RuntimeSourcesConfig {
  const current = input.current ?? {};
  const overrides = input.overrides ?? {};
  const discoveredByKind = new Map(input.discovered.map((entry) => [entry.kind, entry]));
  const next: RuntimeSourcesConfig = { ...current };

  const codexDiscovered = discoveredByKind.get("codex");
  if (
    hasOverrideValue(overrides.codexHomeDir) ||
    hasOverrideValue(overrides.codexMode) ||
    codexDiscovered?.status === "available"
  ) {
    next.codex = {
      enabled: true,
      mode: overrides.codexMode ?? current.codex?.mode ?? "linked",
      homeDir: resolveHomeAwarePath(
        overrides.codexHomeDir ??
          current.codex?.homeDir ??
          codexDiscovered?.homeDir ??
          resolveCodexHomeDir(),
      ),
    };
  }

  const openclawDiscovered = discoveredByKind.get("openclaw");
  if (
    hasOverrideValue(overrides.openclawHomeDir) ||
    hasOverrideValue(overrides.openclawMode) ||
    openclawDiscovered?.status === "available"
  ) {
    next.openclaw = {
      enabled: true,
      mode: overrides.openclawMode ?? current.openclaw?.mode ?? "linked",
      homeDir: resolveHomeAwarePath(
        overrides.openclawHomeDir ??
          current.openclaw?.homeDir ??
          openclawDiscovered?.homeDir ??
          resolveOpenClawHomeDir(),
      ),
    };
  }

  const paperclipDiscovered = discoveredByKind.get("paperclip");
  if (
    hasOverrideValue(overrides.paperclipHomeDir) ||
    hasOverrideValue(overrides.paperclipMode) ||
    hasOverrideValue(overrides.paperclipInstanceId) ||
    paperclipDiscovered?.status === "available"
  ) {
    next.paperclip = {
      enabled: true,
      mode: overrides.paperclipMode ?? current.paperclip?.mode ?? "linked",
      homeDir: resolveHomeAwarePath(
        overrides.paperclipHomeDir ??
          current.paperclip?.homeDir ??
          paperclipDiscovered?.homeDir ??
          resolvePaperclipHomeDir(),
      ),
      instanceId:
        overrides.paperclipInstanceId ??
        current.paperclip?.instanceId ??
        paperclipDiscovered?.inventory.paperclipCurrentInstanceId ??
        resolvePaperclipInstanceId(),
    };
  }

  return next;
}

export function readCodexThreads(homeDir: string, limit = 100): CodexThreadSummary[] {
  const sessionIndexPath = path.join(homeDir, "session_index.jsonl");
  try {
    const raw = fs.readFileSync(sessionIndexPath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, Math.max(1, limit))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : "",
        threadName: typeof entry.thread_name === "string" ? entry.thread_name : null,
        updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : null,
      }))
      .filter((entry) => entry.id.length > 0);
  } catch {
    return [];
  }
}

export function readOpenClawSessions(homeDir: string, limit = 100): OpenClawSessionSummary[] {
  const sessionsIndexPath = path.join(homeDir, "sessions", "sessions.json");
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsIndexPath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];

    return Object.entries(raw as Record<string, unknown>)
      .slice(0, Math.max(1, limit))
      .map(([sessionKey, value]) => {
        const record =
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
        const origin =
          typeof record.origin === "object" && record.origin !== null && !Array.isArray(record.origin)
            ? record.origin as Record<string, unknown>
            : null;
        return {
          sessionKey,
          sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
          updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : null,
          sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : null,
          authProfileOverride:
            typeof record.authProfileOverride === "string" ? record.authProfileOverride : null,
          originLabel: typeof origin?.label === "string" ? origin.label : null,
        };
      })
      .filter((entry) => entry.sessionId || entry.sessionFile);
  } catch {
    return [];
  }
}

function listImmediateNamedEntries(dirPath: string, options: { excludeNames?: string[] } = {}): RuntimeNamedEntry[] {
  try {
    const exclude = new Set(options.excludeNames ?? []);
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => !exclude.has(entry.name))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => ({
        name: entry.name,
        path: path.join(dirPath, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function readCodexSkills(homeDir: string, limit = 100): RuntimeNamedEntry[] {
  return listImmediateNamedEntries(path.join(homeDir, "skills")).slice(0, Math.max(1, limit));
}

export function readCodexPlugins(homeDir: string, limit = 100): RuntimeNamedEntry[] {
  return listImmediateNamedEntries(path.join(homeDir, "plugins"), { excludeNames: ["cache"] }).slice(0, Math.max(1, limit));
}

export function readOpenClawSkills(homeDir: string, limit = 100): RuntimeNamedEntry[] {
  return listImmediateNamedEntries(path.join(homeDir, "skills")).slice(0, Math.max(1, limit));
}
