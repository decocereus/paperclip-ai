import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { getOrCreateOpenClawLiveConversationSession } from "../services/openclaw-live-conversations.js";

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeTempOpenClawHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-openclaw-live-"));
  const homeDir = path.join(root, ".openclaw");
  const externalStoreDir = path.join(root, ".clawdbot", "sessions");
  const sessionsIndexPath = path.join(externalStoreDir, "sessions.json");
  fs.mkdirSync(externalStoreDir, { recursive: true });
  const sessionFile = path.join(homeDir, "agents", "main", "sessions", "agent-main-main.jsonl");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, "");
  fs.writeFileSync(
    path.join(homeDir, "openclaw.json"),
    JSON.stringify({
      session: {
        store: sessionsIndexPath,
      },
    }),
  );
  fs.writeFileSync(
    sessionsIndexPath,
    JSON.stringify({
      "agent:main:main": {
        sessionId: "sess-1",
        sessionFile,
        updatedAt: Date.now(),
      },
    }),
  );
  return { homeDir, sessionFile, sessionsIndexPath };
}

async function createMockGatewayServer() {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-123" },
      }),
    );

    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as {
        type: string;
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };

      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
            },
          }),
        );
        return;
      }

      if (frame.method === "sessions.subscribe" || frame.method === "sessions.messages.subscribe") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              subscribed: true,
              key: frame.params?.key ?? null,
            },
          }),
        );
        return;
      }

      if (frame.method === "sessions.patch") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              ok: true,
              key: frame.params?.key ?? null,
            },
          }),
        );
        return;
      }

      if (frame.method === "sessions.send") {
        const runId = "run-live-1";
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId,
              status: "started",
              acceptedAt: Date.now(),
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "event",
            event: "session.message",
            payload: {
              sessionKey: "agent:main:main",
              messageId: "msg-1",
              messageSeq: 1,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "hello from openclaw" }],
                timestamp: Date.now(),
              },
            },
          }),
        );
        return;
      }

      if (frame.method === "sessions.abort") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { ok: true },
          }),
        );
        return;
      }

      if (frame.method === "sessions.get") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              messages: [
                {
                  type: "message",
                  id: "msg-1",
                  timestamp: new Date().toISOString(),
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "hello from openclaw" }],
                  },
                },
              ],
            },
          }),
        );
        return;
      }

      if (frame.method === "chat.history") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              sessionKey: frame.params?.sessionKey,
              sessionId: "sess-history-1",
              thinkingLevel: "low",
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: "history user" }],
                  timestamp: new Date().toISOString(),
                  __openclaw: { id: "history-u1" },
                },
                {
                  role: "assistant",
                  content: [{ type: "text", text: "history assistant" }],
                  provider: "minimax-portal",
                  model: "MiniMax-M2.7",
                  timestamp: new Date().toISOString(),
                  __openclaw: { id: "history-a1" },
                },
              ],
            },
          }),
        );
        return;
      }

      if (frame.method === "agent.wait") {
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                runId: frame.params?.runId,
                status: "ok",
                startedAt: 1,
                endedAt: 2,
              },
            }),
          );
        }, 200);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("openclaw live conversations", () => {
  it("streams a linked session and can interrupt it", async () => {
    const gateway = await createMockGatewayServer();
    const { homeDir } = makeTempOpenClawHome();

    try {
      const session = getOrCreateOpenClawLiveConversationSession({
        issueId: "issue-live-1",
        sessionKey: "agent:main:main",
        openclawHome: homeDir,
        adapterConfig: {
          url: gateway.url,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
        },
      });

      const runId = await session.send("hello openclaw");
      expect(runId).toBe("run-live-1");

      let snapshot = await session.snapshot(
        "issue-live-1",
        {
          issueId: "issue-live-1",
          companyId: "company-1",
          runtimeKind: "openclaw",
          externalConversationId: "agent:main:main",
          externalConversationLabel: "main",
          metadataJson: null,
          linkedByAgentId: null,
          linkedByUserId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        20,
      );

      if (!snapshot.items.some((item) => item.role === "assistant" && item.text.includes("hello from openclaw"))) {
        await waitFor(async () => {
          const next = await session.snapshot(
            "issue-live-1",
            {
              issueId: "issue-live-1",
              companyId: "company-1",
              runtimeKind: "openclaw",
              externalConversationId: "agent:main:main",
              externalConversationLabel: "main",
              metadataJson: null,
              linkedByAgentId: null,
              linkedByUserId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            20,
          );
          return next.items.some((item) => item.role === "assistant" && item.text.includes("hello from openclaw"));
        });
        snapshot = await session.snapshot(
          "issue-live-1",
          {
            issueId: "issue-live-1",
            companyId: "company-1",
            runtimeKind: "openclaw",
            externalConversationId: "agent:main:main",
            externalConversationLabel: "main",
            metadataJson: null,
            linkedByAgentId: null,
            linkedByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          20,
        );
      }

      expect(snapshot.isStreaming).toBe(true);
      expect(snapshot.activeTurnId).toBe("run-live-1");
      expect(snapshot.items.some((item) => item.role === "assistant" && item.text.includes("hello from openclaw"))).toBe(true);

      const interruptedRunId = await session.interrupt();
      expect(interruptedRunId).toBe("run-live-1");
    } finally {
      await gateway.close();
    }
  });

  it("resolves a logical issue session key to the stored canonical key for snapshots", async () => {
    const gateway = await createMockGatewayServer();
    const { homeDir, sessionFile, sessionsIndexPath } = makeTempOpenClawHome();
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          id: "m1",
          timestamp: "2026-04-08T12:15:11.664Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello from canonical history" }],
          },
        }),
      ].join("\n"),
    );
    fs.writeFileSync(
      sessionsIndexPath,
      JSON.stringify({
        "agent:main:paperclip:issue:issue-live-2": {
          sessionId: "sess-2",
          sessionFile,
          updatedAt: Date.now(),
        },
      }),
    );

    try {
      const session = getOrCreateOpenClawLiveConversationSession({
        issueId: "issue-live-2",
        sessionKey: "paperclip:issue:issue-live-2",
        openclawHome: homeDir,
        adapterConfig: {
          url: gateway.url,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
        },
      });

      const snapshot = await session.snapshot(
        "issue-live-2",
        {
          issueId: "issue-live-2",
          companyId: "company-1",
          runtimeKind: "openclaw",
          externalConversationId: "paperclip:issue:issue-live-2",
          externalConversationLabel: "issue-live-2",
          metadataJson: null,
          linkedByAgentId: null,
          linkedByUserId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        20,
      );

      expect(snapshot.runtimeInfo?.sessionKey).toBe("agent:main:paperclip:issue:issue-live-2");
      expect(snapshot.items.some((item) => item.text.includes("hello from canonical history"))).toBe(true);
      await session.interrupt();
    } finally {
      await gateway.close();
    }
  });

  it("uses gateway chat history when the session has no local transcript file", async () => {
    const gateway = await createMockGatewayServer();
    const { homeDir, sessionsIndexPath } = makeTempOpenClawHome();
    fs.writeFileSync(
      sessionsIndexPath,
      JSON.stringify({
        "agent:main:paperclip:issue:issue-live-3": {
          sessionId: "sess-3",
          updatedAt: Date.now(),
        },
      }),
    );

    try {
      const session = getOrCreateOpenClawLiveConversationSession({
        issueId: "issue-live-3",
        sessionKey: "paperclip:issue:issue-live-3",
        openclawHome: homeDir,
        adapterConfig: {
          url: gateway.url,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
        },
      });

      const snapshot = await session.snapshot(
        "issue-live-3",
        {
          issueId: "issue-live-3",
          companyId: "company-1",
          runtimeKind: "openclaw",
          externalConversationId: "paperclip:issue:issue-live-3",
          externalConversationLabel: "issue-live-3",
          metadataJson: null,
          linkedByAgentId: null,
          linkedByUserId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        20,
      );

      expect(snapshot.items.map((item) => item.text)).toContain("history assistant");
      expect(snapshot.runtimeInfo?.provider).toBe("minimax-portal");
      expect(snapshot.runtimeInfo?.model).toBe("MiniMax-M2.7");
      expect(snapshot.runtimeInfo?.thinking).toBe("low");
      await session.interrupt();
    } finally {
      await gateway.close();
    }
  });
});
