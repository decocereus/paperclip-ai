import type { IssueOriginKind, IssuePriority, IssueStatus } from "../constants.js";
import type { Goal } from "./goal.js";
import type { Project, ProjectWorkspace } from "./project.js";
import type { ExecutionWorkspace, IssueExecutionWorkspaceSettings } from "./workspace-runtime.js";
import type { IssueWorkProduct } from "./work-product.js";

export interface IssueAncestorProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId: string | null;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
}

export interface IssueAncestorGoal {
  id: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
}

export interface IssueAncestor {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  goalId: string | null;
  project: IssueAncestorProject | null;
  goal: IssueAncestorGoal | null;
}

export interface IssueLabel {
  id: string;
  companyId: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueAssigneeAdapterOverrides {
  adapterConfig?: Record<string, unknown>;
  useProjectWorkspace?: boolean;
}

export type DocumentFormat = "markdown";

export interface IssueDocumentSummary {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueDocument extends IssueDocumentSummary {
  body: string;
}

export interface DocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  issueId: string;
  key: string;
  revisionNumber: number;
  title: string | null;
  format: DocumentFormat;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface LegacyPlanDocument {
  key: "plan";
  body: string;
  source: "issue_description";
}

export interface IssueRelationIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface IssueRelation {
  id: string;
  companyId: string;
  issueId: string;
  relatedIssueId: string;
  type: "blocks";
  relatedIssue: IssueRelationIssueSummary;
}

export type IssueRuntimeKind = "codex" | "openclaw";

export interface IssueRuntimeLink {
  issueId: string;
  companyId: string;
  runtimeKind: IssueRuntimeKind;
  externalConversationId: string;
  externalConversationLabel: string | null;
  metadataJson: Record<string, unknown> | null;
  linkedByAgentId: string | null;
  linkedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type IssueConversationItemRole = "user" | "assistant" | "tool" | "system";
export type IssueConversationItemKind = "message" | "reasoning" | "tool_call" | "status";
export type IssueConversationItemStatus = "in_progress" | "completed" | "failed" | "waiting";

export interface IssueConversationItem {
  id: string;
  role: IssueConversationItemRole;
  text: string;
  createdAt: string | null;
  source: IssueRuntimeKind;
  kind?: IssueConversationItemKind | null;
  title?: string | null;
  status?: IssueConversationItemStatus | null;
  metadataJson?: Record<string, unknown> | null;
  rawType?: string | null;
}

export interface IssueConversationRuntimeInfo {
  runtimeKind: IssueRuntimeKind;
  externalConversationId: string;
  externalConversationLabel: string | null;
  model: string | null;
  provider: string | null;
  thinking: string | null;
  reasoning: string | null;
  sessionKey: string | null;
  metadataJson: Record<string, unknown> | null;
}

export interface IssueConversationPendingApproval {
  requestId: string;
  approvalId: string | null;
  kind: "command" | "file";
  turnId: string | null;
  itemId: string | null;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  availableDecisions: string[];
}

export interface IssueConversationSnapshot {
  issueId: string;
  runtimeLink: IssueRuntimeLink | null;
  sourceStatus: "unlinked" | "ok" | "source_unavailable" | "error";
  activeTurnId: string | null;
  isStreaming: boolean;
  runtimeInfo: IssueConversationRuntimeInfo | null;
  pendingApprovals: IssueConversationPendingApproval[];
  items: IssueConversationItem[];
  error: string | null;
}

export interface IssueCreationContext extends Record<string, unknown> {
  sourceKind: "agent_chat" | "agent_chat_fallback" | "manual" | "routine" | "automation";
  sourceAgentId: string | null;
  sourceIssueId: string | null;
  sourceMessageId: string | null;
  sourceActionId: string | null;
  requestText: string | null;
  reason: string | null;
}

export interface Issue {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  goalId: string | null;
  parentId: string | null;
  ancestors?: IssueAncestor[];
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  executionAgentNameKey: string | null;
  executionLockedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  creationContext?: IssueCreationContext | null;
  issueNumber: number | null;
  identifier: string | null;
  originKind?: IssueOriginKind;
  originId?: string | null;
  originRunId?: string | null;
  requestDepth: number;
  billingCode: string | null;
  assigneeAdapterOverrides: IssueAssigneeAdapterOverrides | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  hiddenAt: Date | null;
  labelIds?: string[];
  labels?: IssueLabel[];
  blockedBy?: IssueRelationIssueSummary[];
  blocks?: IssueRelationIssueSummary[];
  runtimeLink?: IssueRuntimeLink | null;
  conversation?: IssueConversationSnapshot | null;
  planDocument?: IssueDocument | null;
  documentSummaries?: IssueDocumentSummary[];
  legacyPlanDocument?: LegacyPlanDocument | null;
  project?: Project | null;
  goal?: Goal | null;
  currentExecutionWorkspace?: ExecutionWorkspace | null;
  workProducts?: IssueWorkProduct[];
  mentionedProjects?: Project[];
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueComment {
  id: string;
  companyId: string;
  issueId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueAttachment {
  id: string;
  companyId: string;
  issueId: string;
  issueCommentId: string | null;
  assetId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
}
