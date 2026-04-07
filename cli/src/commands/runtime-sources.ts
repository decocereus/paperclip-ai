import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import type { RuntimeSourceMode } from "@paperclipai/shared";
import {
  buildLinkedRuntimeSourcesConfig,
  detectRuntimeSources,
  resolveOpenClawHomeDir,
  type RuntimeSourceDiscovery,
  type RuntimeSourceLinkOverrides,
} from "@paperclipai/shared/runtime-sources";
import { readConfig, resolveConfigPath, writeConfig } from "../config/store.js";

const DATA_DIR_OPTION_HELP =
  "Paperclip data directory root (isolates state from ~/.paperclip)";

function formatMaybeCount(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "unknown";
}

function formatDiscoverySummary(entry: RuntimeSourceDiscovery): string[] {
  const lines = [
    `${pc.bold(entry.kind)}: ${entry.status === "available" ? pc.green("available") : entry.status === "missing" ? pc.yellow("missing") : pc.red("error")}`,
    `  home: ${entry.homeDir}`,
  ];

  if (entry.error) {
    lines.push(`  error: ${entry.error}`);
  }

  if (entry.kind === "paperclip" && entry.status === "available") {
    lines.push(`  instances: ${formatMaybeCount(entry.inventory.paperclipInstanceCount)}`);
    if (entry.inventory.paperclipCurrentInstanceId) {
      lines.push(`  current instance: ${entry.inventory.paperclipCurrentInstanceId}`);
    }
  }

  if (entry.kind === "codex" && entry.status === "available") {
    lines.push(`  session index: ${entry.inventory.codexSessionIndexPresent ? "present" : "missing"}`);
    lines.push(`  threads: ${formatMaybeCount(entry.inventory.codexThreadCount)}`);
    lines.push(`  skills: ${entry.inventory.codexSkillsDirPresent ? formatMaybeCount(entry.inventory.codexSkillCount) : "missing"}`);
    lines.push(
      `  plugins: ${entry.inventory.codexPluginsDirPresent ? formatMaybeCount(entry.inventory.codexPluginCount) : "missing"}${entry.inventory.codexPluginCachePresent ? " (+cache)" : ""}`,
    );
  }

  if (entry.kind === "openclaw" && entry.status === "available") {
    lines.push(`  sessions index: ${entry.inventory.openclawSessionsIndexPresent ? "present" : "missing"}`);
    lines.push(`  sessions: ${formatMaybeCount(entry.inventory.openclawSessionCount)}`);
    lines.push(`  skills: ${entry.inventory.openclawSkillsDirPresent ? formatMaybeCount(entry.inventory.openclawSkillCount) : "missing"}`);
    lines.push(`  memory db: ${entry.inventory.openclawMemoryDbPresent ? "present" : "missing"}`);
  }

  return lines;
}

function runtimeSourceModeParser(value: string): RuntimeSourceMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "linked" || normalized === "managed") return normalized;
  throw new Error(`Invalid runtime source mode "${value}". Use "linked" or "managed".`);
}

type DetectShowOptions = {
  json?: boolean;
  config?: string;
};

type LinkOptions = DetectShowOptions & {
  paperclipHome?: string;
  paperclipInstance?: string;
  paperclipMode?: RuntimeSourceMode;
  codexHome?: string;
  codexMode?: RuntimeSourceMode;
  openclawHome?: string;
  openclawMode?: RuntimeSourceMode;
};

type OpenClawTokenOptions = DetectShowOptions & {
  shell?: boolean;
  header?: boolean;
};

function resolveConfiguredOpenClawHome(configPath?: string): string {
  const config = readConfig(configPath);
  return config?.runtimeSources?.openclaw?.homeDir ?? resolveOpenClawHomeDir(process.env);
}

function readOpenClawGatewayToken(homeDir: string): { configPath: string; token: string } {
  const configPath = path.join(homeDir, "openclaw.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`OpenClaw config not found at ${configPath}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse OpenClaw config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const token =
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>).gateway === "object" &&
    (parsed as Record<string, unknown>).gateway !== null &&
    !Array.isArray((parsed as Record<string, unknown>).gateway) &&
    typeof ((parsed as Record<string, unknown>).gateway as Record<string, unknown>).auth === "object" &&
    ((parsed as Record<string, unknown>).gateway as Record<string, unknown>).auth !== null &&
    !Array.isArray(((parsed as Record<string, unknown>).gateway as Record<string, unknown>).auth) &&
    typeof (((parsed as Record<string, unknown>).gateway as Record<string, unknown>).auth as Record<string, unknown>).token === "string"
      ? ((((parsed as Record<string, unknown>).gateway as Record<string, unknown>).auth as Record<string, unknown>).token as string).trim()
      : "";

  if (!token) {
    throw new Error(`OpenClaw gateway token missing in ${configPath} at gateway.auth.token.`);
  }

  return { configPath, token };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export async function detectRuntimeSourcesCommand(opts: DetectShowOptions): Promise<void> {
  const discovered = detectRuntimeSources();

  if (opts.json) {
    console.log(JSON.stringify({ data: discovered }, null, 2));
    return;
  }

  p.intro(pc.bgCyan(pc.black(" paperclipai sources detect ")));
  for (const entry of discovered) {
    for (const line of formatDiscoverySummary(entry)) {
      p.log.message(line);
    }
  }
  p.outro(pc.green("Finished runtime source discovery."));
}

export async function showRuntimeSourcesCommand(opts: DetectShowOptions): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const config = readConfig(opts.config);

  if (!config) {
    p.log.error(`No config found at ${configPath}. Run ${pc.cyan("paperclipai onboard")} first.`);
    return;
  }

  const runtimeSources = config.runtimeSources ?? null;
  if (opts.json) {
    console.log(JSON.stringify({ configPath, runtimeSources }, null, 2));
    return;
  }

  p.intro(pc.bgCyan(pc.black(" paperclipai sources show ")));
  p.log.message(`Config: ${configPath}`);

  if (!runtimeSources) {
    p.log.message(pc.yellow("No runtime sources configured yet."));
    p.outro(pc.dim(`Use ${pc.cyan("paperclipai sources detect")} to inspect local state.`));
    return;
  }

  for (const [kind, entry] of Object.entries(runtimeSources)) {
    if (!entry) continue;
    p.log.message(`${pc.bold(kind)}: ${entry.mode} ${entry.enabled ? "(enabled)" : "(disabled)"}`);
    p.log.message(`  home: ${entry.homeDir}`);
    if (kind === "paperclip" && "instanceId" in entry && entry.instanceId) {
      p.log.message(`  instance: ${entry.instanceId}`);
    }
  }

  p.outro(pc.green("Runtime source configuration loaded."));
}

export async function linkRuntimeSourcesCommand(opts: LinkOptions): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const config = readConfig(opts.config);

  if (!config) {
    p.log.error(`No config found at ${configPath}. Run ${pc.cyan("paperclipai onboard")} first.`);
    return;
  }

  const discovered = detectRuntimeSources();
  const overrides: RuntimeSourceLinkOverrides = {
    ...(opts.paperclipHome ? { paperclipHomeDir: opts.paperclipHome } : {}),
    ...(opts.paperclipInstance ? { paperclipInstanceId: opts.paperclipInstance } : {}),
    ...(opts.paperclipMode ? { paperclipMode: opts.paperclipMode } : {}),
    ...(opts.codexHome ? { codexHomeDir: opts.codexHome } : {}),
    ...(opts.codexMode ? { codexMode: opts.codexMode } : {}),
    ...(opts.openclawHome ? { openclawHomeDir: opts.openclawHome } : {}),
    ...(opts.openclawMode ? { openclawMode: opts.openclawMode } : {}),
  };

  const nextRuntimeSources = buildLinkedRuntimeSourcesConfig({
    current: config.runtimeSources,
    discovered,
    overrides,
  });

  if (Object.keys(nextRuntimeSources).length === 0) {
    p.log.error("No available runtime sources were detected and no overrides were provided.");
    return;
  }

  config.runtimeSources = nextRuntimeSources;
  config.$meta.updatedAt = new Date().toISOString();
  config.$meta.source = "configure";
  writeConfig(config, opts.config);

  if (opts.json) {
    console.log(JSON.stringify({ configPath, runtimeSources: nextRuntimeSources }, null, 2));
    return;
  }

  p.intro(pc.bgCyan(pc.black(" paperclipai sources link ")));
  p.log.success(`Updated runtime sources in ${configPath}`);
  for (const [kind, entry] of Object.entries(nextRuntimeSources)) {
    if (!entry) continue;
    p.log.message(`${pc.bold(kind)} -> ${entry.mode} ${entry.homeDir}`);
    if (kind === "paperclip" && "instanceId" in entry && entry.instanceId) {
      p.log.message(`  instance: ${entry.instanceId}`);
    }
  }
  p.outro(pc.dim("Restart the Paperclip server after changing linked runtime sources."));
}

export async function showOpenClawGatewayTokenCommand(opts: OpenClawTokenOptions): Promise<void> {
  const homeDir = resolveConfiguredOpenClawHome(opts.config);
  const { configPath, token } = readOpenClawGatewayToken(homeDir);

  if (opts.json) {
    console.log(JSON.stringify({ homeDir, configPath, token }, null, 2));
    return;
  }

  if (opts.shell) {
    console.log(`export OPENCLAW_GATEWAY_TOKEN=${shellQuote(token)}`);
    return;
  }

  if (opts.header) {
    console.log(`x-openclaw-token: ${token}`);
    return;
  }

  console.log(token);
}

export function registerRuntimeSourceCommands(program: Command) {
  const sources = program.command("sources").description("Discover and link local runtime homes");

  sources
    .command("detect")
    .description("Detect local Paperclip, Codex, and OpenClaw homes")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--json", "Print discovery results as JSON", false)
    .action(detectRuntimeSourcesCommand);

  sources
    .command("show")
    .description("Show currently configured runtime source links")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--json", "Print runtime source config as JSON", false)
    .action(showRuntimeSourcesCommand);

  sources
    .command("link")
    .description("Link detected local runtime homes into the Paperclip config")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--paperclip-home <path>", "Paperclip home directory to link")
    .option("--paperclip-instance <id>", "Paperclip instance id to link")
    .option("--paperclip-mode <mode>", "Paperclip source mode (linked|managed)", runtimeSourceModeParser)
    .option("--codex-home <path>", "Codex home directory to link")
    .option("--codex-mode <mode>", "Codex source mode (linked|managed)", runtimeSourceModeParser)
    .option("--openclaw-home <path>", "OpenClaw home directory to link")
    .option("--openclaw-mode <mode>", "OpenClaw source mode (linked|managed)", runtimeSourceModeParser)
    .option("--json", "Print resulting runtime source config as JSON", false)
    .action(linkRuntimeSourcesCommand);

  sources
    .command("openclaw-token")
    .description("Print the local OpenClaw gateway token from the linked OpenClaw home")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--json", "Print token metadata as JSON", false)
    .option("--shell", "Print a shell export command for OPENCLAW_GATEWAY_TOKEN", false)
    .option("--header", "Print an x-openclaw-token header line", false)
    .action(showOpenClawGatewayTokenCommand);
}
