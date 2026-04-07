import { describe, expect, it } from "vitest";
import { parseOpenClawSessionJsonl } from "../services/runtime-conversations.js";

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
});
