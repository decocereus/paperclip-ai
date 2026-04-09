import type { IssueConversationItem } from "@paperclipai/shared";

export type AgentConversationRelayAction = {
  key: string;
  targetAgentId: string;
  body: string;
};

export type AgentConversationRelayResult = {
  key: string;
  targetAgentId: string;
  targetAgentName: string | null;
  body: string;
  status: string | null;
};

export type IssueCreateActionResult = {
  key: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  assigneeAgentId: string | null;
  status: string | null;
  mode: "created" | "reused_existing" | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function extractAgentConversationRelayActions(
  item: Pick<IssueConversationItem, "id" | "metadataJson">,
  namespace = item.id,
): AgentConversationRelayAction[] {
  const metadata = asObject(item.metadataJson);
  const rawActions = Array.isArray(metadata?.paperclipActions) ? metadata.paperclipActions : [];

  return rawActions.flatMap((action, index) => {
    const record = asObject(action);
    if (!record || record.type !== "agent_conversation_send") return [];

    const targetAgentId =
      typeof record.targetAgentId === "string" && record.targetAgentId.trim().length > 0
        ? record.targetAgentId.trim()
        : null;
    const body =
      typeof record.body === "string" && record.body.trim().length > 0
        ? record.body.trim()
        : null;

    if (!targetAgentId || !body) return [];

    return [{
      key: `${namespace}:${item.id}:${index}`,
      targetAgentId,
      body,
    }];
  });
}

export function extractAgentConversationRelayResults(
  item: Pick<IssueConversationItem, "id" | "metadataJson">,
  namespace = item.id,
): AgentConversationRelayResult[] {
  const metadata = asObject(item.metadataJson);
  const rawResults = Array.isArray(metadata?.paperclipActionResults) ? metadata.paperclipActionResults : [];

  return rawResults.flatMap((result, index) => {
    const record = asObject(result);
    if (!record || record.type !== "agent_conversation_send") return [];

    const targetAgentId =
      typeof record.targetAgentId === "string" && record.targetAgentId.trim().length > 0
        ? record.targetAgentId.trim()
        : null;
    const body =
      typeof record.body === "string" && record.body.trim().length > 0
        ? record.body.trim()
        : null;

    if (!targetAgentId || !body) return [];

    return [{
      key: `${namespace}:${item.id}:${index}`,
      targetAgentId,
      targetAgentName:
        typeof record.targetAgentName === "string" && record.targetAgentName.trim().length > 0
          ? record.targetAgentName.trim()
          : null,
      body,
      status:
        typeof record.status === "string" && record.status.trim().length > 0
          ? record.status.trim()
          : null,
    }];
  });
}

export function normalizeRelayBody(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function summarizeRelayRequest(sourceLabel: string, targetLabel: string, body: string) {
  const normalizedBody = stripPaperclipActionBlocks(body).replace(/\s+/g, " ").trim();
  if (!normalizedBody) return `${sourceLabel} coordinated with ${targetLabel}.`;

  const withoutLeadingMention = normalizedBody
    .replace(new RegExp(`^@${escapeRegExp(targetLabel)}\\b[:,.-]?\\s*`, "i"), "")
    .trim();
  const previewBase = withoutLeadingMention || normalizedBody;
  const preview = previewBase.length > 92 ? `${previewBase.slice(0, 89)}...` : previewBase;

  return `${sourceLabel} coordinated with ${targetLabel}: ${preview}`;
}

export function stripPaperclipActionBlocks(value: string) {
  return value
    .replace(/\[\[paperclip-action\]\][\s\S]*?\[\[\/paperclip-action\]\]/gi, "")
    .replace(/\[\[paperclip-action\]\][\s\S]*$/i, "")
    .trim();
}

export function extractIssueCreateActionResults(
  item: Pick<IssueConversationItem, "id" | "metadataJson">,
  namespace = item.id,
): IssueCreateActionResult[] {
  const metadata = asObject(item.metadataJson);
  const rawResults = Array.isArray(metadata?.paperclipActionResults) ? metadata.paperclipActionResults : [];

  return rawResults.flatMap((result, index) => {
    const record = asObject(result);
    if (!record || record.type !== "issue_create") return [];
    const issueId =
      typeof record.issueId === "string" && record.issueId.trim().length > 0
        ? record.issueId.trim()
        : null;
    const issueTitle =
      typeof record.issueTitle === "string" && record.issueTitle.trim().length > 0
        ? record.issueTitle.trim()
        : null;

    if (!issueId || !issueTitle) return [];

    return [{
      key: `${namespace}:${item.id}:${index}`,
      issueId,
      issueIdentifier:
        typeof record.issueIdentifier === "string" && record.issueIdentifier.trim().length > 0
          ? record.issueIdentifier.trim()
          : null,
      issueTitle,
      assigneeAgentId:
        typeof record.assigneeAgentId === "string" && record.assigneeAgentId.trim().length > 0
          ? record.assigneeAgentId.trim()
          : null,
      status:
        typeof record.status === "string" && record.status.trim().length > 0
          ? record.status.trim()
          : null,
      mode:
        record.mode === "created" || record.mode === "reused_existing"
          ? record.mode
          : null,
    }];
  });
}

export function findRelayAssistantReplies(
  items: readonly IssueConversationItem[],
  relayBody: string,
): {
  hasMatchingUser: boolean;
  assistantItems: IssueConversationItem[];
} {
  const normalizedRelayBody = normalizeRelayBody(relayBody);
  if (!normalizedRelayBody) {
    return {
      hasMatchingUser: false,
      assistantItems: [],
    };
  }

  let matchingUserIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.role !== "user") continue;
    if (normalizeRelayBody(item.text) !== normalizedRelayBody) continue;
    matchingUserIndex = index;
    break;
  }

  if (matchingUserIndex < 0) {
    return {
      hasMatchingUser: false,
      assistantItems: [],
    };
  }

  return {
    hasMatchingUser: true,
    assistantItems: items
      .slice(matchingUserIndex + 1)
      .filter((item): item is IssueConversationItem => item.role === "assistant"),
  };
}
