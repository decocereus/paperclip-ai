import { describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { runtimeSourcesCheck } from "../checks/runtime-sources-check.js";

vi.mock("@paperclipai/shared/runtime-sources", () => ({
  detectRuntimeSources: vi.fn(() => []),
}));

function buildConfig(): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-04-06T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/db",
      embeddedPostgresPort: 54329,
      backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: "/tmp/backups" },
    },
    logging: { mode: "file", logDir: "/tmp/logs" },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    telemetry: { enabled: true },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/storage" },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: "/tmp/key" },
    },
  };
}

describe("runtimeSourcesCheck", () => {
  it("passes when runtime sources are configured", () => {
    const config = buildConfig();
    config.runtimeSources = {
      codex: {
        enabled: true,
        mode: "linked",
        homeDir: "/Users/test/.codex",
      },
    };

    const result = runtimeSourcesCheck(config);

    expect(result.status).toBe("pass");
  });
});
