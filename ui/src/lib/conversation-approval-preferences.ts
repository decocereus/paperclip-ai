import type { IssueConversationPendingApproval } from "@paperclipai/shared";

const STORAGE_KEY = "paperclip.conversation-approval-preferences.v1";

type StoredApprovalPreferences = Record<string, "accept" | "acceptForSession">;

export function approvalPreferenceSignature(approval: IssueConversationPendingApproval): string {
  return JSON.stringify({
    kind: approval.kind,
    command: approval.command?.trim() || null,
    cwd: approval.cwd?.trim() || null,
    reason: approval.reason?.trim() || null,
  });
}

function readPreferences(): StoredApprovalPreferences {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as StoredApprovalPreferences;
  } catch {
    return {};
  }
}

function writePreferences(next: StoredApprovalPreferences) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
}

export function loadSavedApprovalDecision(
  approval: IssueConversationPendingApproval,
): "accept" | "acceptForSession" | null {
  const stored = readPreferences()[approvalPreferenceSignature(approval)];
  return stored === "accept" || stored === "acceptForSession" ? stored : null;
}

export function saveApprovalDecision(
  approval: IssueConversationPendingApproval,
  decision: "accept" | "acceptForSession",
) {
  const next = readPreferences();
  next[approvalPreferenceSignature(approval)] = decision;
  writePreferences(next);
}

export function preferredApprovalDecision(
  approval: IssueConversationPendingApproval,
  preference?: "accept" | "acceptForSession" | null,
): "accept" | "acceptForSession" | null {
  if (preference === "acceptForSession" && approval.availableDecisions.includes("acceptForSession")) {
    return "acceptForSession";
  }
  if (approval.availableDecisions.includes("accept")) return "accept";
  if (approval.availableDecisions.includes("acceptForSession")) return "acceptForSession";
  return null;
}
