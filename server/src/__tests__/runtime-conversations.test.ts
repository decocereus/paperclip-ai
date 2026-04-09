import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapOpenClawSessionMessages,
  parseOpenClawSessionJsonl,
  readOpenClawConversationFromHome,
  readOpenClawConversationSnapshotFromHome,
  resolveOpenClawSessionSummary,
} from "../services/runtime-conversations.js";

describe("parseOpenClawSessionJsonl", () => {
  it("normalizes user, assistant, and tool result messages", () => {
    const content = [
      JSON.stringify({
        type: "message",
        id: "1",
        timestamp: "2026-04-07T00:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "2",
        timestamp: "2026-04-07T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "3",
        timestamp: "2026-04-07T00:00:02.000Z",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "{\"ok\":true}" }],
        },
      }),
    ].join("\n");

    expect(parseOpenClawSessionJsonl(content)).toEqual([
      {
        id: "1",
        role: "user",
        text: "hello",
        createdAt: "2026-04-07T00:00:00.000Z",
        source: "openclaw",
        rawType: "user",
      },
      {
        id: "2",
        role: "assistant",
        text: "hi there",
        createdAt: "2026-04-07T00:00:01.000Z",
        source: "openclaw",
        rawType: "assistant",
      },
      {
        id: "3",
        role: "tool",
        text: "{\"ok\":true}",
        createdAt: "2026-04-07T00:00:02.000Z",
        source: "openclaw",
        rawType: "toolResult",
      },
    ]);
  });

  it("reads from the configured session store and resolves canonical prefixed keys", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-openclaw-runtime-"));
    const homeDir = path.join(root, ".openclaw");
    const externalStoreDir = path.join(root, ".clawdbot", "sessions");
    const sessionFile = path.join(homeDir, "agents", "main", "sessions", "sess-1.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.mkdirSync(externalStoreDir, { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, "openclaw.json"),
      JSON.stringify({
        session: {
          store: path.join(externalStoreDir, "sessions.json"),
        },
      }),
    );
    fs.writeFileSync(
      path.join(externalStoreDir, "sessions.json"),
      JSON.stringify({
        "agent:main:paperclip:issue:issue-1": {
          sessionId: "sess-1",
          sessionFile,
          updatedAt: Date.now(),
        },
      }),
    );
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          id: "m1",
          timestamp: "2026-04-08T12:15:11.664Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "hello from issue chat" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m2",
          timestamp: "2026-04-08T12:15:13.643Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "" },
              { type: "text", text: "hello from openclaw" },
            ],
          },
        }),
      ].join("\n"),
    );

    expect(resolveOpenClawSessionSummary(homeDir, "paperclip:issue:issue-1")).toMatchObject({
      sessionKey: "agent:main:paperclip:issue:issue-1",
      sessionId: "sess-1",
    });
    expect(readOpenClawConversationFromHome(homeDir, "paperclip:issue:issue-1", 20)).toEqual([
      {
        id: "m1",
        role: "user",
        text: "hello from issue chat",
        createdAt: "2026-04-08T12:15:11.664Z",
        source: "openclaw",
        rawType: "user",
      },
      {
        id: "m2",
        role: "assistant",
        text: "hello from openclaw",
        createdAt: "2026-04-08T12:15:13.643Z",
        source: "openclaw",
        rawType: "assistant",
      },
    ]);
    expect(readOpenClawConversationSnapshotFromHome(homeDir, "paperclip:issue:issue-1", 20)).toMatchObject({
      sessionKey: "agent:main:paperclip:issue:issue-1",
      provider: null,
      model: null,
      thinking: "on",
    });
  });

  it("strips webchat sender metadata wrappers from user messages", () => {
    const content = [
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-04-08T12:24:04.799Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Sender (untrusted metadata):\n```json\n{\n  \"label\": \"gateway-client\",\n  \"id\": \"gateway-client\"\n}\n```\n\n[Wed 2026-04-08 17:54 GMT+5:30] how r u",
            },
          ],
        },
      }),
    ].join("\n");

    expect(parseOpenClawSessionJsonl(content)).toEqual([
      {
        id: "m1",
        role: "user",
        text: "how r u",
        createdAt: "2026-04-08T12:24:04.799Z",
        source: "openclaw",
        rawType: "user",
      },
    ]);
  });

  it("strips direct agent bootstrap wrappers from user messages", () => {
    const content = [
      JSON.stringify({
        type: "message",
        id: "m-bootstrap",
        timestamp: "2026-04-08T12:24:04.799Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "[[paperclip-agent-chat-bootstrap]]\nDirect board-to-agent chat inside Paperclip.\nIdentity:\n- Agent: Zuko\n[[/paperclip-agent-chat-bootstrap]]\nhello from direct chat",
            },
          ],
        },
      }),
    ].join("\n");

    expect(parseOpenClawSessionJsonl(content)).toEqual([
      {
        id: "m-bootstrap",
        role: "user",
        text: "hello from direct chat",
        createdAt: "2026-04-08T12:24:04.799Z",
        source: "openclaw",
        rawType: "user",
      },
    ]);
  });

  it("hydrates model and thinking metadata from persisted openclaw transcript events", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-openclaw-runtime-meta-"));
    const homeDir = path.join(root, ".openclaw");
    const sessionsDir = path.join(homeDir, "sessions");
    const sessionFile = path.join(sessionsDir, "sess-2.jsonl");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, "openclaw.json"),
      JSON.stringify({}),
    );
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:paperclip:issue:issue-2": {
          sessionId: "sess-2",
          sessionFile,
          updatedAt: Date.now(),
        },
      }),
    );
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "model_change",
          provider: "openai-codex",
          modelId: "gpt-5.3-codex-spark",
        }),
        JSON.stringify({
          type: "thinking_level_change",
          thinkingLevel: "off",
        }),
        JSON.stringify({
          type: "message",
          id: "m2",
          timestamp: "2026-04-08T12:24:06.480Z",
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.3-codex-spark",
            content: [{ type: "text", text: "Hello there" }],
          },
        }),
      ].join("\n"),
    );

    expect(readOpenClawConversationSnapshotFromHome(homeDir, "paperclip:issue:issue-2", 20)).toMatchObject({
      sessionKey: "agent:main:paperclip:issue:issue-2",
      provider: "openai-codex",
      model: "gpt-5.3-codex-spark",
      thinking: "off",
      items: [
        {
          id: "m2",
          role: "assistant",
          text: "Hello there",
        },
      ],
    });
  });

  it("parses gateway chat.history message payloads", () => {
    expect(
      mapOpenClawSessionMessages(
        [
          {
            role: "user",
            content: [{ type: "text", text: "hi from history" }],
            timestamp: "2026-04-08T12:24:04.799Z",
            __openclaw: { id: "u1" },
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "..." },
              { type: "text", text: "hello from history" },
            ],
            provider: "minimax-portal",
            model: "MiniMax-M2.7",
            timestamp: "2026-04-08T12:24:06.480Z",
            __openclaw: { id: "a1" },
          },
        ],
        20,
      ),
    ).toEqual([
      {
        id: "u1",
        role: "user",
        text: "hi from history",
        createdAt: "2026-04-08T12:24:04.799Z",
        source: "openclaw",
        rawType: "user",
      },
      {
        id: "a1",
        role: "assistant",
        text: "hello from history",
        createdAt: "2026-04-08T12:24:06.480Z",
        source: "openclaw",
        rawType: "assistant",
      },
    ]);
  });
});
