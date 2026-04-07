import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onboard } from "../commands/onboard.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };

function createExistingConfigFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-onboard-"));
  const runtimeRoot = path.join(root, "runtime");
  const configPath = path.join(root, ".paperclip", "config.json");
  const config: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: "2026-03-29T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(runtimeRoot, "db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(runtimeRoot, "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(runtimeRoot, "logs"),
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(runtimeRoot, "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(runtimeRoot, "secrets", "master.key"),
      },
    },
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  return { configPath, configText: fs.readFileSync(configPath, "utf8") };
}

describe("onboard", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("preserves an existing config when rerun without flags", async () => {
    const fixture = createExistingConfigFixture();

    await onboard({ config: fixture.configPath });

    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(fixture.configText);
    expect(fs.existsSync(`${fixture.configPath}.backup`)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(fixture.configPath), ".env"))).toBe(true);
  });

  it("preserves an existing config when rerun with --yes", async () => {
    const fixture = createExistingConfigFixture();

    await onboard({ config: fixture.configPath, yes: true, invokedByRun: true });

    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(fixture.configText);
    expect(fs.existsSync(`${fixture.configPath}.backup`)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(fixture.configPath), ".env"))).toBe(true);
  });

  it("links detected runtime sources during non-interactive quickstart onboarding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-onboard-new-"));
    const configPath = path.join(root, ".paperclip", "config.json");
    const paperclipHome = path.join(root, "paperclip-home");
    const codexHome = path.join(root, "codex-home");
    const openclawHome = path.join(root, "openclaw-home");

    fs.mkdirSync(path.join(paperclipHome, "instances", "default"), { recursive: true });
    fs.mkdirSync(path.join(codexHome, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "thr_1" })}\n`);
    fs.mkdirSync(path.join(openclawHome, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(openclawHome, "sessions", "sessions.json"), JSON.stringify({ "agent:main:1": {} }));

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.CODEX_HOME = codexHome;
    process.env.OPENCLAW_HOME = openclawHome;

    await onboard({ config: configPath, yes: true, invokedByRun: true });

    const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as PaperclipConfig;
    expect(written.runtimeSources).toEqual({
      paperclip: {
        enabled: true,
        mode: "linked",
        homeDir: paperclipHome,
        instanceId: "default",
      },
      codex: {
        enabled: true,
        mode: "linked",
        homeDir: codexHome,
      },
      openclaw: {
        enabled: true,
        mode: "linked",
        homeDir: openclawHome,
      },
    });
  });
});
