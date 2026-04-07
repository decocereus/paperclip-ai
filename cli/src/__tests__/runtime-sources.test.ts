import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLinkedRuntimeSourcesConfig,
  detectRuntimeSources,
} from "@paperclipai/shared/runtime-sources";

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-runtime-sources-"));
}

describe("runtime source discovery", () => {
  it("detects paperclip, codex, and openclaw homes with inventory hints", () => {
    const root = makeTempRoot();
    const paperclipHome = path.join(root, "paperclip-home");
    const codexHome = path.join(root, "codex-home");
    const openclawHome = path.join(root, "openclaw-home");

    fs.mkdirSync(path.join(paperclipHome, "instances", "default"), { recursive: true });

    fs.mkdirSync(path.join(codexHome, "skills", "paperclip"), { recursive: true });
    fs.mkdirSync(path.join(codexHome, "plugins", "cache"), { recursive: true });
    fs.mkdirSync(path.join(codexHome, "plugins", "local-dev-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "session_index.jsonl"),
      [
        JSON.stringify({ id: "thr_1", thread_name: "One" }),
        JSON.stringify({ id: "thr_2", thread_name: "Two" }),
      ].join("\n"),
    );

    fs.mkdirSync(path.join(openclawHome, "skills", "paperclip"), { recursive: true });
    fs.mkdirSync(path.join(openclawHome, "skills", "tdd"), { recursive: true });
    fs.mkdirSync(path.join(openclawHome, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(openclawHome, "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(openclawHome, "sessions", "sessions.json"),
      JSON.stringify({
        "agent:main:1": { sessionId: "sess_1" },
        "agent:main:2": { sessionId: "sess_2" },
      }),
    );
    fs.writeFileSync(path.join(openclawHome, "memory", "main.sqlite"), "");

    const discovered = detectRuntimeSources({
      ...process.env,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "default",
      CODEX_HOME: codexHome,
      OPENCLAW_HOME: openclawHome,
    });

    const paperclip = discovered.find((entry) => entry.kind === "paperclip");
    const codex = discovered.find((entry) => entry.kind === "codex");
    const openclaw = discovered.find((entry) => entry.kind === "openclaw");

    expect(paperclip?.status).toBe("available");
    expect(paperclip?.inventory.paperclipInstanceCount).toBe(1);
    expect(paperclip?.inventory.paperclipCurrentInstanceId).toBe("default");

    expect(codex?.status).toBe("available");
    expect(codex?.inventory.codexSessionIndexPresent).toBe(true);
    expect(codex?.inventory.codexThreadCount).toBe(2);
    expect(codex?.inventory.codexSkillCount).toBe(1);
    expect(codex?.inventory.codexPluginCount).toBe(1);
    expect(codex?.inventory.codexPluginCachePresent).toBe(true);

    expect(openclaw?.status).toBe("available");
    expect(openclaw?.inventory.openclawSessionsIndexPresent).toBe(true);
    expect(openclaw?.inventory.openclawSessionCount).toBe(2);
    expect(openclaw?.inventory.openclawSkillCount).toBe(2);
    expect(openclaw?.inventory.openclawMemoryDbPresent).toBe(true);
  });

  it("builds linked runtime source config from discovered homes", () => {
    const discovered = [
      {
        kind: "paperclip" as const,
        homeDir: "/tmp/paperclip-home",
        status: "available" as const,
        error: null,
        inventory: {
          paperclipCurrentInstanceId: "default",
        },
      },
      {
        kind: "codex" as const,
        homeDir: "/tmp/codex-home",
        status: "available" as const,
        error: null,
        inventory: {},
      },
      {
        kind: "openclaw" as const,
        homeDir: "/tmp/openclaw-home",
        status: "available" as const,
        error: null,
        inventory: {},
      },
    ];

    const config = buildLinkedRuntimeSourcesConfig({
      current: null,
      discovered,
      overrides: {
        codexMode: "managed",
      },
    });

    expect(config.paperclip).toEqual({
      enabled: true,
      mode: "linked",
      homeDir: "/tmp/paperclip-home",
      instanceId: "default",
    });
    expect(config.codex).toEqual({
      enabled: true,
      mode: "managed",
      homeDir: "/tmp/codex-home",
    });
    expect(config.openclaw).toEqual({
      enabled: true,
      mode: "linked",
      homeDir: "/tmp/openclaw-home",
    });
  });
});
