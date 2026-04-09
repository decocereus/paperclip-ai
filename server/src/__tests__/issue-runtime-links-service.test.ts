import { describe, expect, it } from "vitest";
import { agentTaskSessions, agents, issueRuntimeLinks, issues } from "@paperclipai/db";
import { issueRuntimeLinkService } from "../services/issue-runtime-links.js";

function createDbStub(input: {
  issue?: Record<string, unknown> | null;
  explicitLink?: Record<string, unknown> | null;
  agent?: Record<string, unknown> | null;
  taskSession?: Record<string, unknown> | null;
}) {
  return {
    select() {
      return {
        from(table: unknown) {
          if (table === issues) {
            return {
              where: async () => (input.issue ? [input.issue] : []),
            };
          }
          if (table === issueRuntimeLinks) {
            return {
              where: async () => (input.explicitLink ? [input.explicitLink] : []),
            };
          }
          if (table === agents) {
            return {
              where: async () => (input.agent ? [input.agent] : []),
            };
          }
          if (table === agentTaskSessions) {
            return {
              where() {
                return {
                  orderBy() {
                    return {
                      limit: async () => (input.taskSession ? [input.taskSession] : []),
                    };
                  },
                };
              },
            };
          }
          throw new Error("Unexpected table access in test stub");
        },
      };
    },
  } as any;
}

describe("issue runtime link service inference", () => {
  it("infers an openclaw runtime link from issue-scoped adapter strategy", async () => {
    const now = new Date("2026-04-08T10:00:00.000Z");
    const service = issueRuntimeLinkService(
      createDbStub({
        issue: {
          id: "issue-1",
          companyId: "company-1",
          assigneeAgentId: "agent-1",
          identifier: "DEC-9",
          title: "Check continuity",
          createdAt: now,
          updatedAt: now,
        },
        agent: {
          id: "agent-1",
          adapterType: "openclaw_gateway",
          adapterConfig: {
            sessionKeyStrategy: "issue",
          },
        },
      }),
    );

    const link = await service.getForIssue("issue-1");

    expect(link).toMatchObject({
      runtimeKind: "openclaw",
      externalConversationId: "paperclip:issue:issue-1",
      externalConversationLabel: "DEC-9",
    });
    expect(link?.metadataJson).toMatchObject({
      inferred: true,
      inferredSource: "adapter_config",
    });
  });

  it("prefers a saved openclaw task session when present", async () => {
    const createdAt = new Date("2026-04-08T10:00:00.000Z");
    const updatedAt = new Date("2026-04-08T11:00:00.000Z");
    const service = issueRuntimeLinkService(
      createDbStub({
        issue: {
          id: "issue-1",
          companyId: "company-1",
          assigneeAgentId: "agent-1",
          identifier: "DEC-9",
          title: "Check continuity",
          createdAt,
          updatedAt,
        },
        agent: {
          id: "agent-1",
          adapterType: "openclaw_gateway",
          adapterConfig: {
            sessionKeyStrategy: "issue",
          },
        },
        taskSession: {
          createdAt,
          updatedAt,
          sessionDisplayId: "main",
          sessionParamsJson: {
            sessionKey: "agent:main:main",
          },
        },
      }),
    );

    const link = await service.getForIssue("issue-1");

    expect(link).toMatchObject({
      runtimeKind: "openclaw",
      externalConversationId: "agent:main:main",
      externalConversationLabel: "main",
    });
    expect(link?.metadataJson).toMatchObject({
      inferred: true,
      inferredSource: "task_session",
    });
  });
});
