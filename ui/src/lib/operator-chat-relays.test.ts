import { describe, expect, it } from "vitest";
import type { IssueConversationItem } from "@paperclipai/shared";
import {
  extractAgentConversationRelayActions,
  extractAgentConversationRelayResults,
  extractIssueCreateActionResults,
  findRelayAssistantReplies,
  stripPaperclipActionBlocks,
  summarizeRelayRequest,
} from "./operator-chat-relays";

describe("operator chat relays", () => {
  it("extracts valid agent relay actions from metadata", () => {
    const item = {
      id: "msg-1",
      role: "assistant",
      text: "@CTO hi",
      createdAt: null,
      source: "codex",
      metadataJson: {
        paperclipActions: [
          { type: "agent_conversation_send", targetAgentId: "agent-2", body: "@CTO hi" },
          { type: "noop" },
        ],
      },
    } satisfies IssueConversationItem;

    expect(extractAgentConversationRelayActions(item, "thread-1")).toEqual([
      {
        key: "thread-1:msg-1:0",
        targetAgentId: "agent-2",
        body: "@CTO hi",
      },
    ]);
  });

  it("finds assistant replies after the latest matching relay user message", () => {
    const items = [
      {
        id: "user-1",
        role: "user",
        text: "@CTO hi",
        createdAt: null,
        source: "codex",
      },
      {
        id: "assistant-1",
        role: "assistant",
        text: "Old reply",
        createdAt: null,
        source: "codex",
      },
      {
        id: "user-2",
        role: "user",
        text: "  @CTO   hi  ",
        createdAt: null,
        source: "codex",
      },
      {
        id: "assistant-2",
        role: "assistant",
        text: "Fresh reply",
        createdAt: null,
        source: "codex",
      },
    ] satisfies IssueConversationItem[];

    expect(findRelayAssistantReplies(items, "@CTO hi")).toEqual({
      hasMatchingUser: true,
      assistantItems: [items[3]!],
    });
  });

  it("extracts delivered relay results from metadata", () => {
    const item = {
      id: "msg-3",
      role: "assistant",
      text: "@Zuko can you send founder context?",
      createdAt: null,
      source: "codex",
      metadataJson: {
        paperclipActionResults: [
          {
            type: "agent_conversation_send",
            targetAgentId: "agent-zuko",
            targetAgentName: "Zuko",
            body: "@Zuko can you send founder context?",
            status: "delivered",
          },
        ],
      },
    } satisfies IssueConversationItem;

    expect(extractAgentConversationRelayResults(item, "thread-1")).toEqual([
      {
        key: "thread-1:msg-3:0",
        targetAgentId: "agent-zuko",
        targetAgentName: "Zuko",
        body: "@Zuko can you send founder context?",
        status: "delivered",
      },
    ]);
  });

  it("strips hidden paperclip action blocks from message text", () => {
    expect(
      stripPaperclipActionBlocks(
        '[[paperclip-action]]{"type":"agent_conversation_send","targetAgentId":"agent-2","body":"@CTO hi"}[[/paperclip-action]]\n@CTO hi',
      ),
    ).toBe("@CTO hi");
  });

  it("extracts issue creation results from metadata", () => {
    const item = {
      id: "msg-2",
      role: "assistant",
      text: "Started work.",
      createdAt: null,
      source: "codex",
      metadataJson: {
        paperclipActionResults: [
          {
            type: "issue_create",
            issueId: "issue-1",
            issueIdentifier: "DEC-11",
            issueTitle: "Prepare Kasane launch strategy",
            assigneeAgentId: "agent-1",
            status: "todo",
            mode: "created",
          },
        ],
      },
    } satisfies IssueConversationItem;

    expect(extractIssueCreateActionResults(item, "thread-1")).toEqual([
      {
        key: "thread-1:msg-2:0",
        issueId: "issue-1",
        issueIdentifier: "DEC-11",
        issueTitle: "Prepare Kasane launch strategy",
        assigneeAgentId: "agent-1",
        status: "todo",
        mode: "created",
      },
    ]);
  });

  it("summarizes relay requests into a board-facing coordination line", () => {
    expect(
      summarizeRelayRequest("CMO", "Zuko", "@Zuko can you send founder context and launch constraints?"),
    ).toBe("CMO coordinated with Zuko: can you send founder context and launch constraints?");
  });
});
