import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useSearchParams } from "@/lib/router";
import type {
  Agent,
  Issue,
  IssueConversationItem,
  IssueConversationPendingApproval,
  IssueConversationSnapshot,
} from "@paperclipai/shared";
import {
  ArrowRight,
  Archive,
  Bot,
  CircleDot,
  Command,
  Loader2,
  MessageSquare,
  Plus,
  Radar,
  Send,
  Sparkles,
  UserRound,
  Users2,
  Workflow,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  loadSavedApprovalDecision,
  preferredApprovalDecision,
  saveApprovalDecision,
} from "@/lib/conversation-approval-preferences";
import {
  extractAgentConversationRelayActions,
  extractAgentConversationRelayResults,
  extractIssueCreateActionResults,
  findRelayAssistantReplies,
  stripPaperclipActionBlocks,
  summarizeRelayRequest,
} from "@/lib/operator-chat-relays";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
  type MessageRole,
} from "@/components/ai-elements/message";

type ChatTarget =
  | { kind: "agent"; id: string }
  | { kind: "issue"; id: string };

type MentionTarget = ChatTarget & {
  label: string;
  description: string;
};

type MentionOption = MentionTarget & {
  insertedLabel: string;
};

type OperatorTimelineItem = {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: string | null;
  targetKind: "agent" | "issue";
  targetId: string;
  targetLabel: string;
  targetHref: string;
  source: string;
  kind?: "message" | "reasoning" | "tool_call" | "status" | "coordination";
  status?: string | null;
  transportKey?: string | null;
  coordination?: {
    sourceLabel: string;
    targetLabel: string;
    body: string;
    preview: string;
  } | null;
};

type PendingTargetState = {
  threadId: string;
  target: ChatTarget;
  statusLabel: "initializing" | "thinking" | "working";
  detail: string | null;
};

type OperatorThread = {
  id: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  selectedTargetParam: string | null;
  timeline: OperatorTimelineItem[];
};

type OperatorThreadState = {
  currentThreadId: string | null;
  threads: OperatorThread[];
};

function compactOperatorTimeline(items: OperatorTimelineItem[]) {
  const compacted: OperatorTimelineItem[] = [];
  for (const item of items) {
    if (
      item.kind === "reasoning" ||
      item.kind === "tool_call" ||
      item.role === "tool" ||
      (item.role === "system" && item.kind !== "status" && item.kind !== "coordination")
    ) {
      continue;
    }
    const previous = compacted[compacted.length - 1];
    if (
      item.role === "assistant" &&
      previous?.role === "assistant" &&
      previous.targetKind === item.targetKind &&
      previous.targetId === item.targetId
    ) {
      compacted[compacted.length - 1] = item;
      continue;
    }
    compacted.push(item);
  }
  return compacted;
}

const OPERATOR_TIMELINE_STORAGE_PREFIX = "paperclip.operator-chat.timeline";
const OPERATOR_THREAD_STORAGE_PREFIX = "paperclip.operator-chat.threads.v1";
const DEFAULT_THREAD_TITLE = "New Meeting";
const FAST_POLL_DELAY_MS = 900;
const SLOW_POLL_DELAY_MS = 2500;
const MAX_TARGET_POLL_ATTEMPTS = 60;

function parseTarget(raw: string | null): ChatTarget | null {
  if (!raw) return null;
  const [kind, ...rest] = raw.split(":");
  const id = rest.join(":").trim();
  if (!id) return null;
  if (kind === "agent" || kind === "issue") {
    return { kind, id };
  }
  return null;
}

function targetToParam(target: ChatTarget | null) {
  return target ? `${target.kind}:${target.id}` : null;
}

function targetKey(target: ChatTarget) {
  return `${target.kind}:${target.id}`;
}

function pendingTargetKey(threadId: string, target: ChatTarget) {
  return `${threadId}::${targetKey(target)}`;
}

function roomWatchKey(threadId: string, target: ChatTarget) {
  return `${threadId}::watch::${targetKey(target)}`;
}

function mentionQueryFromDraft(draft: string) {
  const match = draft.match(/(?:^|\s)@([A-Za-z0-9._-]*)$/);
  return match ? (match[1] ?? "") : null;
}

function mentionTokenFromDraft(draft: string) {
  const match = draft.match(/(^|\s)@([A-Za-z0-9._-]+)/);
  if (!match) return null;
  return {
    raw: match[0],
    prefix: match[1] ?? "",
    token: match[2] ?? "",
  };
}

function allMentionTokensFromDraft(draft: string): string[] {
  const matches = Array.from(draft.matchAll(/(^|\s)@([A-Za-z0-9._-]+)/g));
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const token = match[2]?.trim();
    if (!token) continue;
    const lowered = token.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    ordered.push(token);
  }
  return ordered;
}

function normalizedAgentSearchValue(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "");
}

function storageKey(companyId: string) {
  return `${OPERATOR_TIMELINE_STORAGE_PREFIX}:${companyId}`;
}

function threadsStorageKey(companyId: string) {
  return `${OPERATOR_THREAD_STORAGE_PREFIX}:${companyId}`;
}

function createOperatorThread(partial?: Partial<OperatorThread>): OperatorThread {
  const now = new Date().toISOString();
  return {
    id: partial?.id ?? `thread:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    title: partial?.title ?? DEFAULT_THREAD_TITLE,
    archived: partial?.archived ?? false,
    createdAt: partial?.createdAt ?? now,
    updatedAt: partial?.updatedAt ?? now,
    selectedTargetParam: partial?.selectedTargetParam ?? null,
    timeline: partial?.timeline ?? [],
  };
}

function defaultThreadState(): OperatorThreadState {
  const thread = createOperatorThread();
  return {
    currentThreadId: thread.id,
    threads: [thread],
  };
}

function normalizeThreadState(raw: unknown): OperatorThreadState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.threads)) return null;
  const threads = record.threads
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) =>
      createOperatorThread({
        id: typeof item.id === "string" ? item.id : undefined,
        title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : undefined,
        archived: item.archived === true,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
        selectedTargetParam: typeof item.selectedTargetParam === "string" ? item.selectedTargetParam : null,
        timeline: Array.isArray(item.timeline)
          ? item.timeline.filter(
              (entry): entry is OperatorTimelineItem =>
                typeof entry === "object" &&
                entry !== null &&
                typeof (entry as { id?: unknown }).id === "string",
            )
          : [],
      }))
    .filter((thread) => thread.id.length > 0);
  if (threads.length === 0) return defaultThreadState();
  const currentThreadId =
    typeof record.currentThreadId === "string" && threads.some((thread) => thread.id === record.currentThreadId)
      ? record.currentThreadId
      : threads.find((thread) => !thread.archived)?.id ?? threads[0]?.id ?? null;
  return {
    currentThreadId,
    threads,
  };
}

function loadTimeline(companyId: string): OperatorTimelineItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(companyId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is OperatorTimelineItem =>
        typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string",
    );
  } catch {
    return [];
  }
}

function saveTimeline(companyId: string, items: OperatorTimelineItem[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(companyId), JSON.stringify(items.slice(-200)));
  } catch {
    // ignore storage failures
  }
}

function loadThreadState(companyId: string): OperatorThreadState {
  if (typeof window === "undefined") return defaultThreadState();
  try {
    const raw = window.localStorage.getItem(threadsStorageKey(companyId));
    if (raw) {
      const parsed = normalizeThreadState(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    // ignore parse failures and fall through to legacy migration
  }

  const legacyTimeline = loadTimeline(companyId);
  if (legacyTimeline.length > 0) {
    const migrated = defaultThreadState();
    migrated.threads[0] = createOperatorThread({
      ...migrated.threads[0],
      title: "Imported Meeting",
      timeline: legacyTimeline,
    });
    return migrated;
  }

  return defaultThreadState();
}

function saveThreadState(companyId: string, state: OperatorThreadState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      threadsStorageKey(companyId),
      JSON.stringify({
        currentThreadId: state.currentThreadId,
        threads: state.threads.map((thread) => ({
          ...thread,
          timeline: thread.timeline.slice(-200),
        })),
      }),
    );
  } catch {
    // ignore storage failures
  }
}

function deriveThreadTitle(body: string, targetLabel: string) {
  const trimmed = body.trim().replace(/\s+/g, " ");
  const withoutLeadingMention = trimmed.replace(/^@[\w.-]+\s*/i, "").trim();
  const base = withoutLeadingMention || trimmed || targetLabel;
  return base.length > 48 ? `${base.slice(0, 45)}...` : base;
}

function roleTone(role: MessageRole) {
  return role === "system" || role === "tool" ? "muted" : "default";
}

function participantStatusClass(status: "live" | "speaking" | "waiting" | "present" | "coordinating") {
  if (status === "speaking") return "bg-emerald-500";
  if (status === "waiting") return "bg-amber-500";
  if (status === "coordinating") return "bg-sky-500";
  if (status === "live") return "bg-foreground";
  return "bg-muted-foreground/50";
}

function targetMeta(
  target: ChatTarget,
  agents: Agent[],
  issues: Issue[],
) {
  if (target.kind === "agent") {
    const agent = agents.find((entry) => entry.id === target.id) ?? null;
    return {
      label: agent?.name ?? "Agent",
      href: `/agents/${target.id}/chat`,
      description: agent ? `${agent.role}${agent.title ? ` • ${agent.title}` : ""}` : "Agent",
    };
  }

  const issue = issues.find((entry) => entry.id === target.id) ?? null;
  return {
    label: issue?.identifier ?? issue?.title ?? "Issue",
    href: `/issues/${target.id}`,
    description: issue?.title ?? "Issue",
  };
}

function speakerLabel(item: OperatorTimelineItem) {
  if (item.kind === "reasoning") return "Thinking";
  if (item.kind === "tool_call") return "Tool";
  return item.role === "user" ? "You" : item.role === "assistant" ? item.targetLabel : "Paperclip";
}

function approvalTitle(approval: IssueConversationPendingApproval) {
  return approval.kind === "command" ? "Command approval required" : "File change approval required";
}

export function OperatorChat() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [draft, setDraft] = useState("");
  const [threadState, setThreadState] = useState<OperatorThreadState>(defaultThreadState());
  const [pendingTargets, setPendingTargets] = useState<Record<string, PendingTargetState>>({});
  const [conversationLimit, setConversationLimit] = useState(100);
  const [showArchivedThreads, setShowArchivedThreads] = useState(false);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const autoResolvedApprovalsRef = useRef(new Set<string>());
  const roomWatchStateRef = useRef(new Map<string, Set<string>>());
  const processedIssueResultsRef = useRef(new Set<string>());

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const { data: issues } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId ?? "__none__"), "operator-chat"],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        status: "backlog,todo,in_progress,in_review,blocked,done",
      }),
    enabled: Boolean(selectedCompanyId),
  });

  useEffect(() => {
    if (!selectedCompanyId) return;
    setThreadState(loadThreadState(selectedCompanyId));
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    saveThreadState(selectedCompanyId, threadState);
  }, [selectedCompanyId, threadState]);

  const activeThread = useMemo(() => {
    const current =
      threadState.threads.find((thread) => thread.id === threadState.currentThreadId) ??
      threadState.threads.find((thread) => !thread.archived) ??
      threadState.threads[0] ??
      null;
    return current;
  }, [threadState]);

  const selectedTarget = useMemo(
    () => parseTarget(activeThread?.selectedTargetParam ?? searchParams.get("target")),
    [activeThread?.selectedTargetParam, searchParams],
  );

  const agentMap = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );

  const selectedAgent = useMemo(
    () => (selectedTarget?.kind === "agent" ? (agents ?? []).find((agent) => agent.id === selectedTarget.id) ?? null : null),
    [agents, selectedTarget],
  );
  const selectedIssue = useMemo(
    () => (selectedTarget?.kind === "issue" ? (issues ?? []).find((issue) => issue.id === selectedTarget.id) ?? null : null),
    [issues, selectedTarget],
  );

  const { data: selectedIssueComments } = useQuery({
    queryKey: queryKeys.issues.comments(selectedIssue?.id ?? "__none__"),
    queryFn: () => issuesApi.listComments(selectedIssue!.id),
    enabled: Boolean(selectedIssue?.id),
  });

  const { data: selectedIssueConversation } = useQuery({
    queryKey: [...queryKeys.issues.conversation(selectedIssue?.id ?? "__none__"), conversationLimit, "operator-chat"],
    queryFn: () => issuesApi.getConversation(selectedIssue!.id, conversationLimit),
    enabled: Boolean(selectedIssue?.id),
  });

  const { data: selectedAgentConversation } = useQuery({
    queryKey: [...queryKeys.agents.conversation(selectedAgent?.id ?? "__none__"), conversationLimit, "operator-chat"],
    queryFn: () => agentsApi.conversation(selectedAgent!.id, conversationLimit, selectedCompanyId ?? undefined),
    enabled: Boolean(selectedAgent?.id),
  });

  const currentConversation = selectedTarget?.kind === "issue" ? selectedIssueConversation : selectedAgentConversation;
  const currentTargetMeta = selectedTarget && agents && issues
    ? targetMeta(selectedTarget, agents, issues)
    : null;

  const mentionQuery = mentionQueryFromDraft(draft);
  const mentionSuggestions = useMemo<MentionOption[]>(() => {
    if (mentionQuery == null) return [];
    const token = mentionQuery.trim();
    const lowered = token.toLowerCase();
    const normalized = normalizedAgentSearchValue(token);

    const issueMatches = (issues ?? [])
      .filter((issue) => {
        if (!token) return true;
        return (
          issue.identifier?.toLowerCase().includes(lowered) ||
          issue.title.toLowerCase().includes(lowered)
        );
      })
      .slice(0, 2)
      .map((issue) => ({
        kind: "issue" as const,
        id: issue.id,
        label: issue.identifier ?? issue.title,
        insertedLabel: issue.identifier ?? issue.title,
        description: issue.title,
      }));

    const agentMatches = (agents ?? [])
      .filter((agent) => {
        if (!token) return true;
        const name = agent.name.toLowerCase();
        const urlKey = agent.urlKey?.toLowerCase?.() ?? "";
        return (
          name.includes(lowered) ||
          urlKey.includes(lowered) ||
          normalizedAgentSearchValue(agent.name).includes(normalized)
        );
      })
      .slice(0, 5)
      .map((agent) => ({
        kind: "agent" as const,
        id: agent.id,
        label: agent.name,
        insertedLabel: agent.name,
        description: `${agent.role}${agent.title ? ` • ${agent.title}` : ""}`,
      }));

    return [...agentMatches, ...issueMatches].slice(0, 5);
  }, [agents, issues, mentionQuery]);

  const suggestedTargets = useMemo<MentionTarget[]>(() => {
    const suggestedIssues = (issues ?? [])
      .filter((issue) => issue.status !== "done" && issue.status !== "cancelled")
      .slice(0, 4)
      .map((issue) => ({
        kind: "issue" as const,
        id: issue.id,
        label: issue.identifier ?? issue.title,
        description: issue.title,
      }));
    const suggestedAgents = (agents ?? [])
      .slice(0, 4)
      .map((agent) => ({
        kind: "agent" as const,
        id: agent.id,
        label: agent.name,
        description: `${agent.role}${agent.title ? ` • ${agent.title}` : ""}`,
      }));
    return [...suggestedAgents, ...suggestedIssues];
  }, [agents, issues]);

  const displayTimeline = useMemo(
    () => compactOperatorTimeline(activeThread?.timeline ?? []),
    [activeThread?.timeline],
  );

  const activeThreads = useMemo(
    () => threadState.threads.filter((thread) => !thread.archived),
    [threadState.threads],
  );
  const archivedThreads = useMemo(
    () => threadState.threads.filter((thread) => thread.archived),
    [threadState.threads],
  );
  const visiblePendingTargets = useMemo(
    () => Object.entries(pendingTargets).filter(([, pendingState]) => pendingState.threadId === activeThread?.id),
    [activeThread?.id, pendingTargets],
  );
  const roomParticipants = useMemo(() => {
    const next = new Map<string, {
      key: string;
      label: string;
      tone: "default" | "muted";
      status: "live" | "speaking" | "waiting" | "present" | "coordinating";
    }>();
    next.set("board", { key: "board", label: "Board", tone: "default", status: "live" });

    if (selectedTarget && currentTargetMeta) {
      next.set(`focus:${targetKey(selectedTarget)}`, {
        key: `focus:${targetKey(selectedTarget)}`,
        label: currentTargetMeta.label,
        tone: "default",
        status: currentConversation?.isStreaming ? "speaking" : "present",
      });
    }

    for (const item of displayTimeline) {
      if (item.role === "assistant") {
        next.set(`participant:${item.targetKind}:${item.targetId}`, {
          key: `participant:${item.targetKind}:${item.targetId}`,
          label: item.targetLabel,
          tone: "default",
          status: "present",
        });
      }
      if (item.kind === "status" || item.kind === "coordination") {
        next.set("paperclip", { key: "paperclip", label: "Paperclip", tone: "muted", status: "coordinating" });
      }
    }

    for (const [, pendingState] of visiblePendingTargets) {
      const meta = targetMeta(pendingState.target, agents ?? [], issues ?? []);
      next.set(`pending:${targetKey(pendingState.target)}`, {
        key: `pending:${targetKey(pendingState.target)}`,
        label: meta.label,
        tone: "default",
        status: "waiting",
      });
      next.set("paperclip", { key: "paperclip", label: "Paperclip", tone: "muted", status: "coordinating" });
    }

    return Array.from(next.values()).slice(0, 8);
  }, [agents, currentConversation?.isStreaming, currentTargetMeta, displayTimeline, issues, selectedTarget, visiblePendingTargets]);
  const roomAgentTargets = useMemo<ChatTarget[]>(() => {
    const seen = new Set<string>();
    const next: ChatTarget[] = [];
    const add = (target: ChatTarget | null) => {
      if (!target || target.kind !== "agent") return;
      const key = targetKey(target);
      if (seen.has(key)) return;
      seen.add(key);
      next.push(target);
    };

    add(selectedTarget?.kind === "agent" ? selectedTarget : null);

    const reversedTimeline = [...(activeThread?.timeline ?? [])].reverse();
    for (const item of reversedTimeline) {
      if (item.role !== "assistant" || item.targetKind !== "agent") continue;
      add({ kind: "agent", id: item.targetId });
    }

    for (const [, pendingState] of visiblePendingTargets) {
      add(pendingState.target);
    }

    return next;
  }, [activeThread?.timeline, selectedTarget, visiblePendingTargets]);
  const companyAgentTargets = useMemo<ChatTarget[]>(
    () =>
      (agents ?? [])
        .filter((agent) => agent.status !== "terminated")
        .map((agent) => ({ kind: "agent" as const, id: agent.id })),
    [agents],
  );
  const roomSummary = selectedTarget && currentTargetMeta
    ? `The floor is currently with ${currentTargetMeta.label}. Mention someone else at any time to redirect the conversation.`
    : roomAgentTargets.length > 0
      ? `No single focus is selected. New generic messages will go to the active participants already in this room.`
      : companyAgentTargets.length > 0
        ? `No single focus is selected. Generic messages will go to the company room by default.`
        : "Mention any agent or issue to direct the floor. Paperclip will keep the shared room coherent as agents relay and reply.";
  const threadUpdatedAt = activeThread?.updatedAt
    ? new Date(activeThread.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;
  const activeReplyCount = displayTimeline.filter((item) => item.role === "assistant").length;
  const liveRoomCount = visiblePendingTargets.length + (currentConversation?.isStreaming ? 1 : 0);
  const hasConversationStarted = displayTimeline.length > 0;

  function updateThread(threadId: string, updater: (thread: OperatorThread) => OperatorThread) {
    setThreadState((current) => ({
      ...current,
      threads: current.threads.map((thread) => (thread.id === threadId ? updater(thread) : thread)),
    }));
  }

  function appendToThread(threadId: string, item: OperatorTimelineItem) {
    updateThread(threadId, (thread) => ({
      ...thread,
      updatedAt: new Date().toISOString(),
      timeline: [...thread.timeline, item].slice(-200),
    }));
  }

  function appendAssistantItemToThread(
    threadId: string,
    target: ChatTarget,
    item: IssueConversationItem,
  ) {
    if (!agents || !issues) return;
    const meta = targetMeta(target, agents, issues);
    const transportKey = `${targetKey(target)}:${item.id}`;
    const cleanText = stripPaperclipActionBlocks(item.text);
    if (!cleanText) return;
    const timelineItem: OperatorTimelineItem = {
      id: transportKey,
      role: item.role as MessageRole,
      text: cleanText,
      createdAt: item.createdAt,
      targetKind: target.kind,
      targetId: target.id,
      targetLabel: meta.label,
      targetHref: meta.href,
      source: item.source,
      kind: (
        item.kind === "reasoning" || item.kind === "tool_call"
          ? item.kind
          : "message"
      ) as OperatorTimelineItem["kind"],
      status: item.status ?? null,
      transportKey,
    };
    updateThread(threadId, (thread) => {
      if (thread.timeline.some((entry) => entry.transportKey === transportKey)) {
        return thread;
      }
      return {
        ...thread,
        updatedAt: new Date().toISOString(),
        timeline: [...thread.timeline, timelineItem].slice(-200),
      };
    });
  }

  function appendStatusItemToThread(
    threadId: string,
    target: ChatTarget,
    text: string,
    transportKey: string,
  ) {
    const cleanText = stripPaperclipActionBlocks(text);
    if (!cleanText) return;
    const timelineItem: OperatorTimelineItem = {
      id: transportKey,
      role: "system",
      text: cleanText,
      createdAt: new Date().toISOString(),
      targetKind: target.kind,
      targetId: target.id,
      targetLabel: targetMeta(target, agents ?? [], issues ?? []).label,
      targetHref: targetMeta(target, agents ?? [], issues ?? []).href,
      source: "paperclip",
      kind: "status",
      status: null,
      transportKey,
    };
    updateThread(threadId, (thread) => {
      if (thread.timeline.some((entry) => entry.transportKey === transportKey)) {
        return thread;
      }
      return {
        ...thread,
        updatedAt: new Date().toISOString(),
        timeline: [...thread.timeline, timelineItem].slice(-200),
      };
    });
  }

  function appendCoordinationItemToThread(
    threadId: string,
    sourceTarget: ChatTarget,
    target: ChatTarget,
    body: string,
    transportKey: string,
  ) {
    const sourceMeta = targetMeta(sourceTarget, agents ?? [], issues ?? []);
    const relayMeta = targetMeta(target, agents ?? [], issues ?? []);
    const cleanBody = stripPaperclipActionBlocks(body);
    if (!cleanBody) return;
    const preview = summarizeRelayRequest(sourceMeta.label, relayMeta.label, cleanBody);
    const timelineItem: OperatorTimelineItem = {
      id: transportKey,
      role: "system",
      text: preview,
      createdAt: new Date().toISOString(),
      targetKind: target.kind,
      targetId: target.id,
      targetLabel: relayMeta.label,
      targetHref: relayMeta.href,
      source: "paperclip",
      kind: "coordination",
      status: null,
      transportKey,
      coordination: {
        sourceLabel: sourceMeta.label,
        targetLabel: relayMeta.label,
        body: cleanBody,
        preview,
      },
    };
    updateThread(threadId, (thread) => {
      if (thread.timeline.some((entry) => entry.transportKey === transportKey)) {
        return thread;
      }
      return {
        ...thread,
        updatedAt: new Date().toISOString(),
        timeline: [...thread.timeline, timelineItem].slice(-200),
      };
    });
  }

  function setActiveThread(threadId: string) {
    setThreadState((current) => ({
      ...current,
      currentThreadId: threadId,
    }));
    const thread = threadState.threads.find((entry) => entry.id === threadId) ?? null;
    const nextTarget = parseTarget(thread?.selectedTargetParam ?? null);
    const nextParams = new URLSearchParams(searchParams);
    const encoded = targetToParam(nextTarget);
    if (encoded) nextParams.set("target", encoded);
    else nextParams.delete("target");
    setSearchParams(nextParams, { replace: true });
    setConversationLimit(100);
  }

  function createNewThread() {
    const thread = createOperatorThread();
    setThreadState((current) => ({
      currentThreadId: thread.id,
      threads: [thread, ...current.threads],
    }));
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("target");
    setSearchParams(nextParams, { replace: true });
    setConversationLimit(100);
    setDraft("");
  }

  function archiveActiveThread() {
    if (!activeThread) return;
    const remainingActive = threadState.threads.filter((thread) => thread.id !== activeThread.id && !thread.archived);
    let nextThreadId = remainingActive[0]?.id ?? null;
    let createdThread: OperatorThread | null = null;
    if (!nextThreadId) {
      createdThread = createOperatorThread();
      nextThreadId = createdThread.id;
    }
    setThreadState((current) => ({
      currentThreadId: nextThreadId,
      threads: [
        ...(createdThread ? [createdThread] : []),
        ...current.threads.map((thread) =>
          thread.id === activeThread.id
            ? { ...thread, archived: true, updatedAt: new Date().toISOString() }
            : thread,
        ),
      ],
    }));
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("target");
    setSearchParams(nextParams, { replace: true });
    setConversationLimit(100);
  }

  function setTarget(next: ChatTarget | null) {
    const nextParams = new URLSearchParams(searchParams);
    const encoded = targetToParam(next);
    if (encoded) nextParams.set("target", encoded);
    else nextParams.delete("target");
    setSearchParams(nextParams, { replace: true });
    setConversationLimit(100);
    if (activeThread) {
      updateThread(activeThread.id, (thread) => ({
        ...thread,
        selectedTargetParam: encoded,
      }));
    }
  }

  function resolveMentionTarget(token: string): ChatTarget | null {
    const lowered = token.toLowerCase();
    const normalized = normalizedAgentSearchValue(token);
    const issueMatch = (issues ?? []).find(
      (issue) => issue.identifier?.toLowerCase() === lowered,
    );
    if (issueMatch) return { kind: "issue", id: issueMatch.id };

    const agentMatch = (agents ?? []).find((agent) => {
      const urlKey = agent.urlKey?.toLowerCase?.() ?? "";
      return (
        urlKey === lowered ||
        agent.name.toLowerCase() === lowered ||
        normalizedAgentSearchValue(agent.name) === normalized
      );
    });
    if (agentMatch) return { kind: "agent", id: agentMatch.id };
    return null;
  }

  async function fetchSnapshot(target: ChatTarget): Promise<IssueConversationSnapshot> {
    if (target.kind === "issue") {
      return issuesApi.getConversation(target.id, 200);
    }
    return agentsApi.conversation(target.id, 200, selectedCompanyId ?? undefined);
  }

  function cacheSnapshot(target: ChatTarget, snapshot: IssueConversationSnapshot) {
    if (target.kind === "issue") {
      queryClient.setQueryData(
        [...queryKeys.issues.conversation(target.id), conversationLimit, "operator-chat"],
        snapshot,
      );
      return;
    }
    queryClient.setQueryData(
      [...queryKeys.agents.conversation(target.id), conversationLimit, "operator-chat"],
      snapshot,
    );
  }

  function appendConversationDelta(
    threadId: string,
    target: ChatTarget,
    snapshot: IssueConversationSnapshot,
    baselineIds: Set<string>,
  ): IssueConversationItem[] {
    if (!agents || !issues) return [];
    const meta = targetMeta(target, agents, issues);
    const key = targetKey(target);
    const nextItems = snapshot.items
      .filter((item) => !baselineIds.has(item.id))
      .filter((item) => item.role === "assistant")
      .filter((item) => stripPaperclipActionBlocks(item.text).length > 0)
      .map((item) => ({
        ...item,
        transportKey: `${key}:${item.id}`,
      }));

    const finalItem = nextItems.at(-1);
    if (!finalItem) return [];
    const timelineItem: OperatorTimelineItem = {
      id: `${key}:${finalItem.id}`,
      role: finalItem.role as MessageRole,
      text: stripPaperclipActionBlocks(finalItem.text),
      createdAt: finalItem.createdAt,
      targetKind: target.kind,
      targetId: target.id,
      targetLabel: meta.label,
      targetHref: meta.href,
      source: finalItem.source,
      kind: (
        finalItem.kind === "reasoning" || finalItem.kind === "tool_call"
          ? finalItem.kind
          : "message"
      ) as OperatorTimelineItem["kind"],
      status: finalItem.status ?? null,
      transportKey: finalItem.transportKey,
    };
    updateThread(threadId, (thread) => {
      const seen = new Set(thread.timeline.map((entry) => entry.transportKey).filter(Boolean));
      if (finalItem.transportKey && seen.has(finalItem.transportKey)) {
        return thread;
      }
      return {
        ...thread,
        updatedAt: new Date().toISOString(),
        timeline: [...thread.timeline, timelineItem].slice(-200),
      };
    });
    return nextItems;
  }

  function describePendingSnapshot(
    snapshot: IssueConversationSnapshot,
  ): Omit<PendingTargetState, "threadId" | "target"> {
    const latestNonUser = [...snapshot.items].reverse().find((item) => item.role !== "user") ?? null;
    if (!latestNonUser) {
      return { statusLabel: "initializing", detail: null };
    }
    if (latestNonUser.kind === "tool_call") {
      return {
        statusLabel: "working",
        detail: latestNonUser.title?.trim() || latestNonUser.text.trim() || "using a tool",
      };
    }
    if (latestNonUser.kind === "reasoning") {
      return {
        statusLabel: "thinking",
        detail: null,
      };
    }
    return {
      statusLabel: "working",
      detail: null,
    };
  }

  function markTargetPending(
    threadId: string,
    target: ChatTarget,
    pending: Omit<PendingTargetState, "threadId" | "target"> | null,
  ) {
    const key = pendingTargetKey(threadId, target);
    setPendingTargets((current) => {
      if (pending) return { ...current, [key]: { ...pending, threadId, target } };
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  const processedRelayActionsRef = useRef(new Set<string>());

  async function processRelayActions(
    threadId: string,
    sourceTarget: ChatTarget,
    items: IssueConversationItem[],
  ) {
    if (!agents || !issues) return;

    for (const item of items) {
      const relayResults = extractAgentConversationRelayResults(item, `${threadId}:${targetKey(sourceTarget)}`);
      const actions = relayResults.length > 0
        ? relayResults.map((result) => ({
          key: result.key,
          targetAgentId: result.targetAgentId,
          body: result.body,
        }))
        : extractAgentConversationRelayActions(item, `${threadId}:${targetKey(sourceTarget)}`);
      for (const action of actions) {
        if (processedRelayActionsRef.current.has(action.key)) continue;
        processedRelayActionsRef.current.add(action.key);

        const relayTarget: ChatTarget = { kind: "agent", id: action.targetAgentId };
        appendCoordinationItemToThread(
          threadId,
          sourceTarget,
          relayTarget,
          action.body,
          `relay-status:${action.key}`,
        );

        try {
          const snapshot = await fetchSnapshot(relayTarget);
          cacheSnapshot(relayTarget, snapshot);
          const relayWindow = findRelayAssistantReplies(snapshot.items, action.body);

          if (!snapshot.isStreaming && relayWindow.hasMatchingUser && relayWindow.assistantItems.length > 0) {
            const finalReply = relayWindow.assistantItems.at(-1);
            if (finalReply) {
              appendAssistantItemToThread(threadId, relayTarget, finalReply);
              void processRelayActions(threadId, relayTarget, [finalReply]);
            }
            continue;
          }
          void pollRelayTargetConversation(threadId, relayTarget, action.body);
        } catch {}
      }
    }
  }

  async function pollRelayTargetConversation(
    threadId: string,
    target: ChatTarget,
    relayBody: string,
  ) {
    let settled = false;
    try {
      for (let attempt = 0; attempt < MAX_TARGET_POLL_ATTEMPTS; attempt += 1) {
        const snapshot = await fetchSnapshot(target);
        cacheSnapshot(target, snapshot);
        const relayWindow = findRelayAssistantReplies(snapshot.items, relayBody);

        if (!snapshot.isStreaming && relayWindow.hasMatchingUser && relayWindow.assistantItems.length > 0) {
          const finalReply = relayWindow.assistantItems.at(-1);
          if (finalReply) {
            appendAssistantItemToThread(threadId, target, finalReply);
            void processRelayActions(threadId, target, [finalReply]);
          }
          settled = true;
          break;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, attempt < 12 ? FAST_POLL_DELAY_MS : SLOW_POLL_DELAY_MS),
        );
      }
    } catch {
      // ignore background relay polling errors; canonical direct chats still exist
    } finally {
      if (!settled) {
        const meta = targetMeta(target, agents ?? [], issues ?? []);
        appendStatusItemToThread(
          threadId,
          target,
          `Still waiting on ${meta.label}.`,
          `relay-wait:${threadId}:${targetKey(target)}`,
        );
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.conversation(target.id) });
    }
  }

  async function pollTargetConversation(
    threadId: string,
    target: ChatTarget,
    baselineIds: Set<string>,
  ) {
    let settled = false;
    try {
      for (let attempt = 0; attempt < MAX_TARGET_POLL_ATTEMPTS; attempt += 1) {
        const snapshot = await fetchSnapshot(target);
        cacheSnapshot(target, snapshot);
        if (!snapshot.isStreaming) {
          const nextItems = appendConversationDelta(threadId, target, snapshot, baselineIds);
          snapshot.items.forEach((item) => baselineIds.add(item.id));
          void processRelayActions(threadId, target, nextItems);
          settled = true;
          break;
        }
        const pending = describePendingSnapshot(snapshot);
        markTargetPending(threadId, target, pending);
        await new Promise((resolve) =>
          setTimeout(resolve, attempt < 12 ? FAST_POLL_DELAY_MS : SLOW_POLL_DELAY_MS),
        );
      }
    } catch {
      // ignore background polling errors; canonical chats still exist
    } finally {
      if (settled) {
        markTargetPending(threadId, target, null);
      } else {
        markTargetPending(threadId, target, {
          statusLabel: "working",
          detail: "Still working on a reply",
        });
      }
      if (target.kind === "issue") {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.conversation(target.id) });
      } else {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.conversation(target.id) });
      }
    }
  }

  const interruptCurrentConversation = useMutation({
    mutationFn: async () => {
      if (!selectedTarget) throw new Error("No target selected");
      if (selectedTarget.kind === "issue") {
        return issuesApi.interruptConversation(selectedTarget.id);
      }
      return agentsApi.interruptConversation(selectedTarget.id, selectedCompanyId ?? undefined);
    },
    onSuccess: () => {
      if (!selectedTarget) return;
      if (selectedTarget.kind === "issue") {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.conversation(selectedTarget.id) });
      } else {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.conversation(selectedTarget.id) });
      }
    },
    onError: (error) => {
      pushToast({
        title: "Interrupt failed",
        body: error instanceof Error ? error.message : "Unable to interrupt active chat",
        tone: "error",
      });
    },
  });

  const resolveCurrentApproval = useMutation({
    mutationFn: async ({
      requestId,
      decision,
    }: {
      requestId: string;
      decision: "accept" | "acceptForSession" | "decline" | "cancel";
    }) => {
      if (!selectedTarget) throw new Error("No target selected");
      if (selectedTarget.kind === "issue") {
        return issuesApi.resolveConversationApproval(selectedTarget.id, requestId, decision);
      }
      return agentsApi.resolveConversationApproval(
        selectedTarget.id,
        requestId,
        decision,
        selectedCompanyId ?? undefined,
      );
    },
    onSuccess: () => {
      if (!selectedTarget) return;
      if (selectedTarget.kind === "issue") {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.conversation(selectedTarget.id) });
      } else {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.conversation(selectedTarget.id) });
      }
    },
    onError: (error) => {
      pushToast({
        title: "Approval failed",
        body: error instanceof Error ? error.message : "Unable to resolve approval",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    const approvals = currentConversation?.pendingApprovals ?? [];
    for (const approval of approvals) {
      if (autoResolvedApprovalsRef.current.has(approval.requestId)) continue;
      const savedDecision = loadSavedApprovalDecision(approval);
      const decision = savedDecision ? preferredApprovalDecision(approval, savedDecision) : null;
      if (!decision) continue;
      autoResolvedApprovalsRef.current.add(approval.requestId);
      resolveCurrentApproval.mutate({
        requestId: approval.requestId,
        decision,
      });
    }
  }, [currentConversation?.pendingApprovals, resolveCurrentApproval]);

  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    setActiveMentionIndex(0);
  }, [mentionQuery]);

  function applyMentionSuggestion(option: MentionOption) {
    setTarget({ kind: option.kind, id: option.id });
    setDraft((current) =>
      current.replace(/(?:^|\s)@[A-Za-z0-9._-]*$/, ` @${option.insertedLabel} `).trimStart(),
    );
  }

  function processIssueCreateResults(
    threadId: string,
    target: ChatTarget,
    items: IssueConversationItem[],
  ) {
    for (const item of items) {
      const results = extractIssueCreateActionResults(item, `${threadId}:${targetKey(target)}`);
      for (const result of results) {
        if (processedIssueResultsRef.current.has(result.key)) continue;
        processedIssueResultsRef.current.add(result.key);

        const issueLabel = result.issueIdentifier ?? result.issueTitle;
        appendStatusItemToThread(
          threadId,
          target,
          result.mode === "reused_existing"
            ? `Reused issue ${issueLabel}: ${result.issueTitle}.`
            : `Created issue ${issueLabel}: ${result.issueTitle}.`,
          `issue-create:${result.key}`,
        );
        pushToast({
          dedupeKey: `issue-create:${result.key}`,
          title: result.mode === "reused_existing"
            ? `${targetMeta(target, agents ?? [], issues ?? []).label} reused an issue`
            : `${targetMeta(target, agents ?? [], issues ?? []).label} created an issue`,
          body: `${issueLabel}: ${result.issueTitle}`,
          tone: "success",
        });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId ?? "__none__") });
      }
    }
  }

  useEffect(() => {
    const threadId = activeThread?.id;
    if (!threadId || roomAgentTargets.length === 0) return;

    let cancelled = false;

    const syncRoomReplies = async () => {
      for (const target of roomAgentTargets) {
        if (cancelled || target.kind !== "agent") return;

        try {
          const snapshot = await fetchSnapshot(target);
          if (cancelled) return;
          cacheSnapshot(target, snapshot);

          const watchKey = roomWatchKey(threadId, target);
          let knownAssistantIds = roomWatchStateRef.current.get(watchKey);
          const assistantItems = snapshot.items
            .filter((item): item is IssueConversationItem => item.role === "assistant")
            .filter((item) => stripPaperclipActionBlocks(item.text).length > 0);

          if (!knownAssistantIds) {
            knownAssistantIds = new Set(assistantItems.map((item) => item.id));
            roomWatchStateRef.current.set(watchKey, knownAssistantIds);
          } else {
            const unseenItems = assistantItems.filter((item) => !knownAssistantIds!.has(item.id));
            if (unseenItems.length > 0) {
              unseenItems.forEach((item) => {
                knownAssistantIds!.add(item.id);
                appendAssistantItemToThread(threadId, target, item);
              });
              processIssueCreateResults(threadId, target, unseenItems);
              void processRelayActions(threadId, target, unseenItems);

              const latest = unseenItems.at(-1);
              if (latest) {
                const meta = targetMeta(target, agents ?? [], issues ?? []);
                pushToast({
                  dedupeKey: `meeting-reply:${threadId}:${targetKey(target)}:${latest.id}`,
                  title: `${meta.label} replied`,
                  body: stripPaperclipActionBlocks(latest.text),
                  tone: "info",
                });
              }
            }
          }

          if (snapshot.isStreaming) {
            markTargetPending(threadId, target, describePendingSnapshot(snapshot));
          } else {
            markTargetPending(threadId, target, null);
          }
        } catch {
          // ignore background watch errors; direct chat remains canonical
        }
      }
    };

    void syncRoomReplies();
    const interval = window.setInterval(() => {
      void syncRoomReplies();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeThread?.id, agents, issues, pushToast, roomAgentTargets, selectedCompanyId]);

  async function deliverTurnToTarget(
    threadId: string,
    target: ChatTarget,
    body: string,
    baselineIds: Set<string>,
  ) {
    markTargetPending(threadId, target, { statusLabel: "initializing", detail: null });

    let after: IssueConversationSnapshot;
    if (target.kind === "issue") {
      const stickyIssueConversation =
        selectedTarget?.kind === "issue" && selectedTarget.id === target.id
          ? selectedIssueConversation
          : null;
      const isStreaming = stickyIssueConversation?.isStreaming === true;
      if (isStreaming) {
        await issuesApi.steerConversation(target.id, body);
      } else {
        await issuesApi.sendConversation(target.id, body);
      }
      after = await issuesApi.getConversation(target.id, 200);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.conversation(target.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(target.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(target.id) }),
      ]);
    } else {
      const stickyAgentConversation =
        selectedTarget?.kind === "agent" && selectedTarget.id === target.id
          ? selectedAgentConversation
          : null;
      const isStreaming = stickyAgentConversation?.isStreaming === true;
      after = isStreaming
        ? await agentsApi.steerConversation(target.id, body, selectedCompanyId ?? undefined)
        : await agentsApi.sendConversation(target.id, body, selectedCompanyId ?? undefined);
      queryClient.setQueryData(
        [...queryKeys.agents.conversation(target.id), conversationLimit, "operator-chat"],
        after,
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.conversation(target.id) });
    }

      if (after.isStreaming) {
        const pending = describePendingSnapshot(after);
        markTargetPending(threadId, target, pending);
        void pollTargetConversation(threadId, target, baselineIds);
      } else {
        markTargetPending(threadId, target, null);
        const nextItems = appendConversationDelta(threadId, target, after, baselineIds);
        after.items.forEach((item) => baselineIds.add(item.id));
        processIssueCreateResults(threadId, target, nextItems);
        void processRelayActions(threadId, target, nextItems);
      }
  }

  async function handleSend() {
    const originalBody = draft.trim();
    let body = originalBody;
    if (!body || isSending) return;

    const mentionTokens = allMentionTokensFromDraft(body);
    const mention = mentionTokenFromDraft(body);
    let target = selectedTarget;
    if (mention) {
      const resolved = resolveMentionTarget(mention.token);
      if (!resolved) {
        pushToast({
          title: "Unknown mention",
          body: `No agent or issue matched @${mention.token}`,
          tone: "error",
        });
        return;
      }
      target = resolved;
      setTarget(resolved);
    }

    const roomTargets =
      target
        ? [target]
        : roomAgentTargets.length > 0
          ? roomAgentTargets
          : companyAgentTargets;

    if (roomTargets.length === 0) {
      pushToast({
        title: "Choose a target",
        body: "There are no available agents in this company room yet.",
        tone: "error",
      });
      return;
    }

    if (!body) {
      setDraft("");
      return;
    }

    const currentAgents = agents ?? [];
    const currentIssues = issues ?? [];
    const primaryTarget = roomTargets[0]!;
    const meta = targetMeta(primaryTarget, currentAgents, currentIssues);
    const additionalMentionedAgentTargets = mentionTokens
      .map((token) => resolveMentionTarget(token))
      .filter((candidate): candidate is ChatTarget => candidate != null)
      .filter((candidate) => candidate.kind === "agent" && !roomTargets.some((entry) => targetKey(entry) === targetKey(candidate)));
    const threadId = activeThread?.id;
    if (!threadId) return;

    appendToThread(threadId, {
      id: `local:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      role: "user",
      text: originalBody,
      createdAt: new Date().toISOString(),
      targetKind: primaryTarget.kind,
      targetId: primaryTarget.id,
      targetLabel: roomTargets.length > 1 ? "Room" : meta.label,
      targetHref: meta.href,
      source: "paperclip",
      kind: "message",
      transportKey: null,
    });
    if (activeThread && (activeThread.title === DEFAULT_THREAD_TITLE || activeThread.timeline.length === 0)) {
      updateThread(threadId, (thread) => ({
        ...thread,
        title: deriveThreadTitle(originalBody, meta.label),
        updatedAt: new Date().toISOString(),
      }));
    }

    setIsSending(true);
    try {
      if (!target && roomTargets.length > 1) {
        appendStatusItemToThread(
          threadId,
          primaryTarget,
          `Addressing the room: ${roomTargets.map((entry) => targetMeta(entry, currentAgents, currentIssues).label).join(", ")}.`,
          `room-broadcast:${Date.now()}`,
        );
      }

      await Promise.all(roomTargets.map(async (roomTarget) => {
        const baselineSnapshot = await fetchSnapshot(roomTarget).catch(() => null);
        const baselineIds = new Set((baselineSnapshot?.items ?? []).map((item) => item.id));
        await deliverTurnToTarget(threadId, roomTarget, body, baselineIds);
      }));

      if (additionalMentionedAgentTargets.length > 0) {
        const mentionResults = await Promise.allSettled(
          additionalMentionedAgentTargets.map(async (mentionedTarget) => {
            if (mentionedTarget.kind !== "agent") return;
            const mentionedMeta = targetMeta(mentionedTarget, currentAgents, currentIssues);
            const fyi =
              `Board meeting context: the board sent this message to ${meta.label}: "${originalBody}"\n\n` +
              `You were mentioned as @${mentionedMeta.label}. Do not respond unless directly asked, unless the board addresses you next, or unless you have concrete relevant information to add.`;
            await agentsApi.sendConversation(mentionedTarget.id, fyi, selectedCompanyId ?? undefined);
          }),
        );
        const failedMentions = mentionResults.filter((result) => result.status === "rejected");
        if (failedMentions.length > 0) {
          pushToast({
            title: "Some FYI mentions did not deliver",
            body: `${failedMentions.length} background mention${failedMentions.length === 1 ? "" : "s"} failed, but the main room message still went through.`,
            tone: "error",
          });
        }
      }
      setDraft("");
    } catch (error) {
      roomTargets.forEach((roomTarget) => {
        markTargetPending(threadId, roomTarget, null);
      });
      pushToast({
        title: "Send failed",
        body: error instanceof Error ? error.message : "Unable to send chat message",
        tone: "error",
      });
    } finally {
      setIsSending(false);
    }
  }

  if (!selectedCompanyId) {
    return (
      <div className="rounded-xl border border-border/70 bg-card/60 p-6 text-sm text-muted-foreground">
        Select a company first to use operator chat.
      </div>
    );
  }

  const overviewSection = (
    <div className="relative overflow-hidden rounded-[28px] border border-border/60 bg-card/80 p-5 shadow-sm sm:p-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.16),transparent_40%),radial-gradient(circle_at_85%_15%,hsl(var(--muted-foreground)/0.14),transparent_30%)]" />
      <div className="relative space-y-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(18rem,1fr)]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
              <MessageSquare className="h-3.5 w-3.5" />
              <span>Board Meeting</span>
              {selectedCompany ? <Badge variant="outline">{selectedCompany.issuePrefix}</Badge> : null}
              {liveRoomCount > 0 ? <Badge variant="secondary">{liveRoomCount} live</Badge> : null}
            </div>
            <div className="space-y-2">
              <h1 className="max-w-3xl text-2xl font-semibold tracking-tight sm:text-[2rem]">
                {activeThread?.title ?? DEFAULT_THREAD_TITLE}
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                {roomSummary}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {roomParticipants.map((participant) => (
                <div
                  key={participant.key}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm shadow-sm",
                    participant.tone === "default"
                      ? "bg-background/85 text-foreground ring-1 ring-border/60"
                      : "bg-muted/40 text-muted-foreground ring-1 ring-border/40",
                  )}
                >
                  <span className={cn("h-2 w-2 rounded-full", participantStatusClass(participant.status))} />
                  <span>{participant.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <div className="rounded-2xl bg-background/70 px-4 py-3 shadow-sm ring-1 ring-border/50">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                <CircleDot className="h-3.5 w-3.5" />
                Focus
              </div>
              <div className="mt-2 text-sm font-medium">
                {currentTargetMeta?.label ?? "Room-wide"}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {currentTargetMeta?.description ?? "Generic notes will go to the active participants in the room."}
              </p>
            </div>
            <div className="rounded-2xl bg-background/70 px-4 py-3 shadow-sm ring-1 ring-border/50">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                <Users2 className="h-3.5 w-3.5" />
                Activity
              </div>
              <div className="mt-2 text-sm font-medium">
                {displayTimeline.length} turn{displayTimeline.length === 1 ? "" : "s"} logged
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {activeReplyCount > 0
                  ? `${activeReplyCount} visible agent repl${activeReplyCount === 1 ? "y" : "ies"} in this thread.`
                  : "No agent replies yet in this room."}
              </p>
            </div>
            <div className="rounded-2xl bg-background/70 px-4 py-3 shadow-sm ring-1 ring-border/50">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                <Command className="h-3.5 w-3.5" />
                Rhythm
              </div>
              <div className="mt-2 text-sm font-medium">
                {threadUpdatedAt ? `Updated ${threadUpdatedAt}` : "Fresh thread"}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Cmd/Ctrl+Enter sends. `@` opens mention autocomplete.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
              <Users2 className="h-3.5 w-3.5" />
              <span>Threads</span>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="h-10 rounded-xl" onClick={createNewThread}>
                <Plus className="h-3.5 w-3.5" />
                New Thread
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-10 rounded-xl"
                onClick={archiveActiveThread}
                disabled={!activeThread}
              >
                <Archive className="h-3.5 w-3.5" />
                Archive
              </Button>
            </div>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {activeThreads.map((thread) => {
              const isActive = activeThread?.id === thread.id;
              return (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => setActiveThread(thread.id)}
                  className={cn(
                    "min-w-[180px] rounded-2xl px-4 py-3 text-left shadow-sm transition-colors duration-200 ease-out ring-1",
                    isActive
                      ? "bg-background text-foreground ring-border/50"
                      : "bg-background/55 text-muted-foreground ring-border/35 hover:bg-background/80",
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium leading-5">{thread.title}</div>
                    {isActive ? <Badge variant="secondary">Live</Badge> : null}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{thread.timeline.length} item{thread.timeline.length === 1 ? "" : "s"}</span>
                    <ArrowRight className="h-3 w-3" />
                    <span>{new Date(thread.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {archivedThreads.length > 0 ? (
            <div className="space-y-2">
              <button
                type="button"
                className="text-xs text-muted-foreground transition-colors duration-200 ease-out hover:text-foreground"
                onClick={() => setShowArchivedThreads((current) => !current)}
              >
                {showArchivedThreads ? "Hide archived threads" : `Show archived threads (${archivedThreads.length})`}
              </button>
              {showArchivedThreads ? (
                <div className="flex flex-wrap gap-2">
                  {archivedThreads.map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      onClick={() => setActiveThread(thread.id)}
                      className="rounded-2xl border border-border/60 bg-background/40 px-4 py-2.5 text-left text-muted-foreground transition-colors duration-200 ease-out hover:bg-background/70"
                    >
                      <div className="text-sm font-medium">{thread.title}</div>
                      <div className="text-[11px]">Archived thread</div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  const chatSection = (
    <div className="overflow-hidden rounded-[28px] bg-background">
      <div className="flex h-[calc(100dvh-4.5rem)] min-h-[44rem] flex-col bg-background">
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="gap-4 px-4 py-5 sm:px-5">
            {displayTimeline.length === 0 ? (
              <ConversationEmptyState
                icon={<Radar className="h-5 w-5" />}
                title="Board chat is ready"
                description="Mention an agent or issue to start a routed conversation from one place. Generic messages will go to the room once participants are active."
              />
            ) : (
              displayTimeline.map((item) => {
                const label = speakerLabel(item);
                const isStatus = item.kind === "status";
                const coordination = item.kind === "coordination" ? item.coordination ?? null : null;
                const isCoordination = coordination != null;
                const showTargetChip = !isStatus && !isCoordination && item.targetLabel !== label && item.targetLabel !== "Room";
                return (
                  <Message
                    key={item.id}
                    from={item.role}
                    className={cn((isStatus || isCoordination) && "items-start")}
                  >
                    <div
                      className={cn(
                        "flex items-center gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground",
                        item.role === "user" && !isStatus && "justify-end",
                      )}
                    >
                      {item.kind === "tool_call" ? <Wrench className="h-3.5 w-3.5" /> : null}
                      {item.role === "assistant" && item.kind !== "tool_call" ? <Sparkles className="h-3.5 w-3.5" /> : null}
                      {isStatus ? <Sparkles className="h-3.5 w-3.5" /> : null}
                      {isCoordination ? <Workflow className="h-3.5 w-3.5" /> : null}
                      <span className="font-medium normal-case tracking-normal">
                        {isCoordination ? "Coordination" : label}
                      </span>
                      {showTargetChip ? (
                        <button
                          type="button"
                          onClick={() => setTarget({ kind: item.targetKind, id: item.targetId })}
                          className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] normal-case tracking-normal hover:bg-accent/40"
                        >
                          {item.targetLabel}
                        </button>
                      ) : null}
                      {item.createdAt ? (
                        <span className="normal-case tracking-normal">
                          {new Date(item.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                        </span>
                      ) : null}
                      {item.status ? <Badge variant="outline">{item.status}</Badge> : null}
                    </div>
                    {coordination ? (
                      <MessageContent
                        tone="muted"
                        className="max-w-3xl rounded-2xl bg-background/35 px-4 py-3 shadow-none ring-1 ring-border/35"
                      >
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <div className="text-sm font-medium text-foreground">
                              {coordination.preview}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Private agent-to-agent note routed through Paperclip.
                            </div>
                          </div>
                          <details className="group rounded-xl bg-background/40 px-3 py-2 ring-1 ring-border/30">
                            <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground">
                              <span className="group-open:hidden">View note</span>
                              <span className="hidden group-open:inline">Hide note</span>
                            </summary>
                            <div className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                              {coordination.body}
                            </div>
                          </details>
                        </div>
                      </MessageContent>
                    ) : (
                      <MessageContent
                        tone={isStatus ? "muted" : roleTone(item.role)}
                        className={cn(
                          isStatus && "max-w-2xl rounded-2xl bg-background/40 px-4 py-2.5 shadow-none",
                          item.role === "assistant" && !isStatus && "max-w-3xl rounded-2xl bg-background/40 px-4 py-3 shadow-none",
                          item.role === "user" && "shadow-sm ring-1 ring-inset ring-primary/10",
                        )}
                      >
                        <MessageResponse className={cn(isStatus && "prose-p:my-0")}>
                          {stripPaperclipActionBlocks(item.text)}
                        </MessageResponse>
                      </MessageContent>
                    )}
                  </Message>
                );
              })
            )}

            {(currentConversation?.pendingApprovals ?? []).map((approval) => (
              <Message key={`approval:${approval.requestId}`} from="assistant">
                <div className="flex items-center gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" />
                  <span className="font-medium normal-case tracking-normal">{currentTargetMeta?.label ?? "Agent"}</span>
                  <Badge variant="outline">needs approval</Badge>
                </div>
                <MessageContent tone="muted">
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                    <div className="text-sm font-medium">
                      {approval.kind === "command" ? "Allow command?" : approvalTitle(approval)}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {approval.reason ?? approval.command ?? "The runtime is waiting for approval."}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={resolveCurrentApproval.isPending || !preferredApprovalDecision(approval, "accept")}
                        onClick={() => {
                          const decision = preferredApprovalDecision(approval, "accept");
                          if (!decision) return;
                          resolveCurrentApproval.mutate({
                            requestId: approval.requestId,
                            decision,
                          });
                        }}
                      >
                        Allow for now
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={resolveCurrentApproval.isPending || !preferredApprovalDecision(approval, "acceptForSession")}
                        onClick={() => {
                          const decision = preferredApprovalDecision(approval, "acceptForSession");
                          if (!decision) return;
                          saveApprovalDecision(approval, decision);
                          resolveCurrentApproval.mutate({
                            requestId: approval.requestId,
                            decision,
                          });
                        }}
                      >
                        Allow forever
                      </Button>
                    </div>
                  </div>
                </MessageContent>
              </Message>
            ))}

            {visiblePendingTargets.map(([key, pendingState]) => {
              if (!agents || !issues) return null;
              const meta = targetMeta(pendingState.target, agents, issues);
              return (
                <Message key={`pending:${key}`} from="assistant" className="items-stretch">
                  <div className="flex items-center gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span className="font-medium normal-case tracking-normal">Paperclip</span>
                    <Badge variant="outline">{pendingState.statusLabel}</Badge>
                  </div>
                  <MessageContent tone="muted" className="max-w-2xl rounded-2xl bg-background/40 px-4 py-3 shadow-none">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span>
                        {pendingState.statusLabel === "initializing"
                          ? `${meta.label} is initializing…`
                          : pendingState.statusLabel === "working"
                            ? `${meta.label} is working…`
                            : `${meta.label} is thinking…`}
                      </span>
                    </div>
                    {pendingState.detail ? (
                      <div className="mt-2 text-xs text-muted-foreground">
                        {pendingState.detail}
                      </div>
                    ) : null}
                  </MessageContent>
                </Message>
              );
            })}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="bg-background px-3 pb-3 pt-2 sm:px-4 sm:pb-4">
          <div className="relative flex items-end gap-2">
            <div className="relative flex-1">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={selectedTarget && currentTargetMeta ? "Reply to the room…" : "Message the room…"}
                onKeyDown={(event) => {
                  if (mentionQuery !== null && mentionSuggestions.length > 0) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setActiveMentionIndex((current) => (current + 1) % mentionSuggestions.length);
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setActiveMentionIndex((current) => (current - 1 + mentionSuggestions.length) % mentionSuggestions.length);
                      return;
                    }
                    if ((event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
                      event.preventDefault();
                      const option = mentionSuggestions[activeMentionIndex] ?? mentionSuggestions[0];
                      if (option) applyMentionSuggestion(option);
                      return;
                    }
                  }

                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                className="min-h-[52px] rounded-2xl border-border/30 bg-background/80 px-4 py-3 pr-4 text-[16px] leading-6 shadow-none transition-colors duration-200 ease-out md:min-h-[48px] md:text-sm"
              />

              {mentionQuery !== null && mentionSuggestions.length > 0 ? (
                <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-2xl bg-background/95 shadow-xl ring-1 ring-border/50 backdrop-blur">
                  {mentionSuggestions.map((option, index) => {
                    const isActive = index === activeMentionIndex;
                    return (
                      <button
                        key={`mention-menu:${option.kind}:${option.id}`}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applyMentionSuggestion(option)}
                        className={cn(
                          "flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 ease-out",
                          isActive ? "bg-accent/50" : "hover:bg-accent/30",
                        )}
                      >
                        <div className="space-y-0.5">
                          <div className="text-sm font-medium">@{option.label}</div>
                          <div className="text-xs text-muted-foreground">{option.description}</div>
                        </div>
                        <Badge variant="outline">{option.kind}</Badge>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            {selectedTarget && currentConversation?.isStreaming ? (
              <Button
                type="button"
                variant="outline"
                className="h-12 shrink-0 rounded-2xl px-4"
                onClick={() => interruptCurrentConversation.mutate()}
                disabled={interruptCurrentConversation.isPending}
              >
                {interruptCurrentConversation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {interruptCurrentConversation.isPending ? "Stopping" : "Stop"}
              </Button>
            ) : null}
            <Button
              type="button"
              className="h-12 shrink-0 rounded-2xl px-4"
              onClick={() => void handleSend()}
              disabled={isSending || draft.trim().length === 0}
            >
              <Send className="h-3.5 w-3.5" />
              {isSending ? "Sending..." : "Send"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      {chatSection}
      {overviewSection}
    </div>
  );
}
