import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Brain, Cable, Link2, Loader2, Send, Sparkles, Square, Wrench } from "lucide-react";
import type {
  Agent,
  IssueComment,
  IssueConversationPendingApproval,
  IssueConversationSnapshot,
  IssueRuntimeLink,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse, type MessageRole } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import {
  loadSavedApprovalDecision,
  preferredApprovalDecision,
  saveApprovalDecision,
} from "@/lib/conversation-approval-preferences";
import { stripPaperclipActionBlocks } from "@/lib/operator-chat-relays";

type FallbackChatItem = {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: string | null;
  title: string | null;
  source: string;
  kind?: "message";
  status?: null;
};

type IssueChatPanelProps = {
  runtimeLink: IssueRuntimeLink | null | undefined;
  conversation: IssueConversationSnapshot | undefined;
  conversationLimit: number;
  fallbackComments: IssueComment[];
  agentMap: Map<string, Agent>;
  assistantName: string | null;
  panelTitle?: string;
  linkedDescription?: string;
  unlinkedDescription?: string;
  readyDescription?: string;
  unlinkedTitle?: string;
  allowSendWithoutRuntimeLink?: boolean;
  defaultPlaceholder?: string;
  hideComposer?: boolean;
  currentUserId: string | null;
  composerDisabledReason: string | null;
  isSending: boolean;
  isInterrupting: boolean;
  isResolvingApproval: boolean;
  onLoadOlder: () => void;
  onSend: (body: string) => Promise<void>;
  onInterrupt: () => void;
  onResolveApproval: (requestId: string, decision: "accept" | "acceptForSession" | "decline" | "cancel") => void;
};

function approvalTitle(approval: IssueConversationPendingApproval) {
  return approval.kind === "command" ? "Command approval required" : "File change approval required";
}

function messageTone(role: MessageRole) {
  return role === "tool" || role === "system" ? "muted" : "default";
}

function itemStatusTone(status: string | null | undefined) {
  if (status === "failed") return "destructive";
  if (status === "completed") return "secondary";
  if (status === "in_progress" || status === "waiting") return "outline";
  return "outline";
}

function speakerLabel(input: {
  role: MessageRole;
  kind?: string | null;
  title?: string | null;
  assistantName: string | null;
}) {
  if (input.kind === "reasoning") return input.title ?? "Thinking";
  if (input.kind === "tool_call") return input.title ?? "Tool";
  if (input.role === "user") return input.title ?? "You";
  if (input.role === "assistant") return input.assistantName ?? "Agent";
  if (input.role === "tool") return input.title ?? "Tool";
  return input.title ?? "Paperclip";
}

export function IssueChatPanel({
  runtimeLink,
  conversation,
  conversationLimit,
  fallbackComments,
  agentMap,
  assistantName,
  panelTitle = "Issue Chat",
  linkedDescription = "Talk to the linked runtime session here. This is the main conversation surface for the issue.",
  unlinkedDescription = "Use Comments for formal updates, and link a runtime session when you want a true issue chat.",
  readyDescription = "Send a message to start steering the linked runtime from the issue chat.",
  unlinkedTitle = "Link a runtime first",
  allowSendWithoutRuntimeLink = false,
  defaultPlaceholder,
  hideComposer = false,
  currentUserId,
  composerDisabledReason,
  isSending,
  isInterrupting,
  isResolvingApproval,
  onLoadOlder,
  onSend,
  onInterrupt,
  onResolveApproval,
}: IssueChatPanelProps) {
  const [draft, setDraft] = useState("");
  const autoResolvedApprovalsRef = useRef(new Set<string>());

  const canSend = draft.trim().length > 0 && !isSending && !composerDisabledReason;
  const runtimeConversationItems = conversation?.items ?? [];
  const isStreaming = conversation?.isStreaming === true;
  const pendingApprovals = conversation?.pendingApprovals ?? [];
  const runtimeInfo = conversation?.runtimeInfo ?? null;

  const fallbackHistory = useMemo<FallbackChatItem[]>(
    () =>
      fallbackComments.map((comment) => ({
        id: `comment:${comment.id}`,
        role:
          comment.authorUserId
            ? "user"
            : comment.authorAgentId
              ? "assistant"
              : "system",
        text: comment.body,
        createdAt:
          comment.createdAt instanceof Date
            ? comment.createdAt.toISOString()
            : new Date(comment.createdAt).toISOString(),
        title:
          comment.authorUserId
            ? comment.authorUserId === currentUserId
              ? "You"
              : "Board"
            : comment.authorAgentId
              ? (agentMap.get(comment.authorAgentId)?.name ?? "Agent")
              : "System",
        source: "paperclip",
        kind: "message",
      })),
    [agentMap, currentUserId, fallbackComments],
  );

  const conversationItems = runtimeConversationItems.length > 0 ? runtimeConversationItems : fallbackHistory;
  const canLoadOlder = conversationItems.length >= conversationLimit && conversationLimit < 1000;

  useEffect(() => {
    for (const approval of pendingApprovals) {
      if (autoResolvedApprovalsRef.current.has(approval.requestId)) continue;
      const savedDecision = loadSavedApprovalDecision(approval);
      const decision = savedDecision ? preferredApprovalDecision(approval, savedDecision) : null;
      if (!decision) continue;
      autoResolvedApprovalsRef.current.add(approval.requestId);
      onResolveApproval(approval.requestId, decision);
    }
  }, [onResolveApproval, pendingApprovals]);

  const emptyState = useMemo(() => {
    if (!runtimeLink) {
      return {
        title: allowSendWithoutRuntimeLink ? "Conversation is ready" : unlinkedTitle,
        description: allowSendWithoutRuntimeLink
          ? readyDescription
          : "Connect this issue to a Codex thread or OpenClaw session, then the chat becomes the main place to talk to the agent.",
      };
    }
    if (conversation?.sourceStatus && conversation.sourceStatus !== "ok") {
      return {
        title: "Conversation unavailable",
        description: conversation.error ?? "The linked runtime conversation is not available right now.",
      };
    }
    return {
      title: "Conversation is ready",
      description: readyDescription,
    };
  }, [allowSendWithoutRuntimeLink, conversation?.error, conversation?.sourceStatus, readyDescription, runtimeLink, unlinkedTitle]);

  async function handleSubmit() {
    const body = draft.trim();
    if (!body || isSending || composerDisabledReason) return;
    setDraft("");
    await onSend(body);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/60 px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <span>{panelTitle}</span>
            {runtimeLink ? <Badge variant="outline">{runtimeLink.runtimeKind}</Badge> : null}
            {isStreaming ? <Badge variant="outline">Live</Badge> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {runtimeLink
              ? linkedDescription
              : unlinkedDescription}
          </p>
          {runtimeInfo ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {runtimeInfo.provider ? <Badge variant="outline">{runtimeInfo.provider}</Badge> : null}
              {runtimeInfo.model ? <Badge variant="outline">{runtimeInfo.model}</Badge> : null}
              {runtimeInfo.thinking ? <Badge variant="outline">thinking:{runtimeInfo.thinking}</Badge> : null}
              {runtimeInfo.reasoning ? <Badge variant="outline">reasoning:{runtimeInfo.reasoning}</Badge> : null}
              {runtimeInfo.sessionKey ? (
                <Badge variant="outline" className="max-w-full truncate">
                  {runtimeInfo.sessionKey}
                </Badge>
              ) : null}
            </div>
          ) : null}
        </div>
        {isStreaming ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isInterrupting}
            onClick={onInterrupt}
          >
            {isInterrupting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            {isInterrupting ? "Interrupting..." : "Interrupt"}
          </Button>
        ) : null}
      </div>

      <div className="relative h-[58vh] min-h-[26rem] rounded-2xl border border-border/70 bg-card/40">
        <Conversation className="h-full">
          <ConversationContent className="gap-4 px-4 py-5">
            {conversationItems.length > 0 ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
                <span>{conversationItems.length} message{conversationItems.length === 1 ? "" : "s"} loaded</span>
                {canLoadOlder ? (
                  <Button type="button" size="sm" variant="ghost" onClick={onLoadOlder}>
                    Load older messages
                  </Button>
                ) : null}
              </div>
            ) : null}
            {conversationItems.length === 0 ? (
              <ConversationEmptyState
                icon={<Link2 className="h-5 w-5" />}
                title={emptyState.title}
                description={emptyState.description}
              />
            ) : (
              conversationItems.map((item) => {
                const role = item.role as MessageRole;
                const isReasoning = item.kind === "reasoning";
                const isToolCall = item.kind === "tool_call";
                const cleanText = stripPaperclipActionBlocks(item.text);
                if (!cleanText && !isReasoning && !isToolCall) return null;
                const label = speakerLabel({
                  role,
                  kind: item.kind,
                  title: item.title,
                  assistantName,
                });
                const Icon = isReasoning ? Brain : isToolCall ? Wrench : role === "assistant" ? Sparkles : role === "system" ? Cable : null;
                return (
                  <Message key={`${item.source}:${item.id}`} from={role}>
                    <div
                      className={cn(
                        "flex items-center gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground",
                        role === "user" && "justify-end",
                      )}
                    >
                      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
                      <span className="font-medium normal-case tracking-normal">{label}</span>
                      {role !== "user" ? <Badge variant="outline">{item.source}</Badge> : null}
                      {item.createdAt ? (
                        <span className="normal-case tracking-normal">
                          {new Date(item.createdAt).toLocaleString()}
                        </span>
                      ) : null}
                      {item.status ? <Badge variant={itemStatusTone(item.status)}>{item.status}</Badge> : null}
                    </div>
                    {isReasoning ? (
                      <Collapsible defaultOpen={false} className="w-full">
                        <MessageContent tone="muted">
                          <CollapsibleTrigger className="w-full text-left text-xs font-medium text-muted-foreground">
                            {cleanText ? "Show reasoning" : "Reasoning in progress"}
                          </CollapsibleTrigger>
                          <CollapsibleContent className="pt-2">
                            {cleanText ? <MessageResponse>{cleanText}</MessageResponse> : <div className="text-sm text-muted-foreground">No reasoning text yet.</div>}
                          </CollapsibleContent>
                        </MessageContent>
                      </Collapsible>
                    ) : isToolCall ? (
                      <MessageContent tone="muted">
                        {cleanText ? <MessageResponse>{cleanText}</MessageResponse> : <div className="text-sm text-muted-foreground">Tool call in progress…</div>}
                        {item.metadataJson ? (
                          <pre className="mt-2 overflow-x-auto rounded-lg border border-border/60 bg-background/70 p-3 text-[11px] text-muted-foreground">
                            {JSON.stringify(item.metadataJson, null, 2)}
                          </pre>
                        ) : null}
                      </MessageContent>
                    ) : (
                      <MessageContent tone={messageTone(role)}>
                        <MessageResponse>{cleanText}</MessageResponse>
                      </MessageContent>
                    )}
                  </Message>
                );
              })
            )}
            {pendingApprovals.map((approval) => (
              <Message key={`approval:${approval.requestId}`} from="assistant">
                <div className="flex items-center gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" />
                  <span className="font-medium normal-case tracking-normal">{assistantName ?? "Agent"}</span>
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
                        disabled={isResolvingApproval || !preferredApprovalDecision(approval, "accept")}
                        onClick={() => {
                          const decision = preferredApprovalDecision(approval, "accept");
                          if (!decision) return;
                          onResolveApproval(approval.requestId, decision);
                        }}
                      >
                        Allow for now
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isResolvingApproval || !preferredApprovalDecision(approval, "acceptForSession")}
                        onClick={() => {
                          const decision = preferredApprovalDecision(approval, "acceptForSession");
                          if (!decision) return;
                          saveApprovalDecision(approval, decision);
                          onResolveApproval(approval.requestId, decision);
                        }}
                      >
                        Allow forever
                      </Button>
                    </div>
                  </div>
                </MessageContent>
              </Message>
            ))}
            {isStreaming ? (
              <Message from="assistant">
                <div className="flex items-center gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" />
                  <span className="font-medium normal-case tracking-normal">{assistantName ?? "Agent"}</span>
                  <Badge variant="outline">live</Badge>
                </div>
                <MessageContent>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <div className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-current/60" />
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-current/40 [animation-delay:120ms]" />
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-current/20 [animation-delay:240ms]" />
                    </div>
                    <span>{runtimeInfo?.model ? `${runtimeInfo.model} is responding…` : "The agent is responding…"}</span>
                  </div>
                </MessageContent>
              </Message>
            ) : null}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      </div>

      {!hideComposer ? (
        <div className="rounded-xl border border-border/70 bg-card/60 p-3">
        <div className="space-y-3">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={Boolean(composerDisabledReason) || (!runtimeLink && !allowSendWithoutRuntimeLink)}
            placeholder={
              !runtimeLink && !allowSendWithoutRuntimeLink
                ? "Link a runtime conversation to chat here."
                : defaultPlaceholder
                  ? defaultPlaceholder
                  : !runtimeLink
                    ? "Start a direct chat with this agent..."
                : isStreaming
                  ? "Steer the active turn..."
                  : "Ask the agent about this issue..."
            }
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void handleSubmit();
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              {composerDisabledReason
                ? composerDisabledReason
                : runtimeLink
                  ? "Cmd/Ctrl+Enter to send."
                  : allowSendWithoutRuntimeLink
                    ? "Cmd/Ctrl+Enter to send."
                    : "Comments are still available below for formal updates."}
            </div>
            <Button
              type="button"
              disabled={!canSend || (!runtimeLink && !allowSendWithoutRuntimeLink)}
              onClick={() => void handleSubmit()}
            >
              {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {isSending ? "Sending..." : isStreaming ? "Steer" : "Send"}
            </Button>
          </div>
        </div>
        </div>
      ) : null}
    </div>
  );
}
