import { and, count, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  agents as agentsTable,
  companies,
  issues as issuesTable,
  routines,
} from "@paperclipai/db";
import {
  addIssueCommentSchema,
  normalizeAgentUrlKey,
  resolveIssueConversationApprovalSchema,
  type IssueCreationContext,
  type IssueConversationSnapshot,
  type IssueRuntimeLink,
} from "@paperclipai/shared";
import { buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import {
  agentService,
  heartbeatService,
  issueService,
  logActivity,
  secretService,
} from "../services/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { readConfigFile } from "../config-file.js";
import {
  getExistingCodexLiveConversationSession,
  getOrCreateCodexLiveConversationSession,
} from "../services/codex-live-conversations.js";
import {
  getExistingOpenClawLiveConversationSession,
  getOrCreateOpenClawLiveConversationSession,
} from "../services/openclaw-live-conversations.js";

const AGENT_CHAT_TASK_PREFIX = "agent-chat:";
const DIRECT_CHAT_PROTOCOL_VERSION = 2;

function summarizeConversationBody(body: string | null | undefined) {
  if (typeof body !== "string") return null;
  const trimmed = body.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function normalizeCreationContextText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.length > 600 ? `${trimmed.slice(0, 597)}...` : trimmed;
}

function readRequestId(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseBridgeIssueCreateCommand(command: string): {
  companyId: string;
  payload: {
    title: string;
    description?: string;
    assigneeAgentId?: string | null;
    status?: string;
    priority?: string;
  };
} | null {
  const pathMatch = command.match(/\/api\/companies\/([a-f0-9-]+)\/issues\b/i);
  if (!pathMatch) return null;
  const bodyMatch = command.match(/--body\s+'([^']+)'/);
  if (!bodyMatch) return null;
  const companyId = pathMatch[1]!.trim();
  const normalizedBody = bodyMatch[1]!
    .replace(/\\"/g, "\"")
    .replace(/\\\\n/g, "\\n")
    .replace(/\\\\r/g, "\\r")
    .trim();
  try {
    const parsed = JSON.parse(normalizedBody) as Record<string, unknown>;
    const title = typeof parsed.title === "string" && parsed.title.trim().length > 0 ? parsed.title.trim() : null;
    if (!title) return null;
    return {
      companyId,
      payload: {
        title,
        description:
          typeof parsed.description === "string" && parsed.description.trim().length > 0
            ? parsed.description.trim()
            : undefined,
        assigneeAgentId:
          typeof parsed.assigneeAgentId === "string" && parsed.assigneeAgentId.trim().length > 0
            ? parsed.assigneeAgentId.trim()
            : null,
        status:
          typeof parsed.status === "string" && parsed.status.trim().length > 0
            ? parsed.status.trim()
            : undefined,
        priority:
          typeof parsed.priority === "string" && parsed.priority.trim().length > 0
            ? parsed.priority.trim()
            : undefined,
      },
    };
  } catch {
    return null;
  }
}

function agentChatTaskKey(agentId: string) {
  return `${AGENT_CHAT_TASK_PREFIX}${agentId}`;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readDirectChatProtocolVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractMentionTokens(body: string): string[] {
  const matches = Array.from(body.matchAll(/(^|\s)@([A-Za-z0-9._-]+)/g));
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

function buildLocalDirectChatEnv(agent: {
  id: string;
  companyId: string;
  adapterType: string;
}) {
  const env = { ...buildPaperclipEnv(agent) };
  // Codex direct-chat sandboxes can fail Unix socket access with EPERM even when
  // normal loopback HTTP works, so prefer the bridge's HTTP path here.
  delete env.PAPERCLIP_BRIDGE_SOCKET_PATH;
  const authToken = createLocalAgentJwt(
    agent.id,
    agent.companyId,
    agent.adapterType,
    `direct-chat-${Date.now()}`,
  );
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  return env;
}

function buildAgentChatTurnGuidance(body: string, mentionHints: string[] = []) {
  return [
    "[[paperclip-agent-chat-guidance]]",
    "You are speaking inside Paperclip direct chat.",
    "- Board users or peer agents may message you here.",
    "- Respond as a company agent, not as a terminal transcript.",
    "- Use tools or the Paperclip bridge silently; do not narrate internal debugging, command searches, or permission mechanics unless explicitly asked.",
    "- Keep responses concise and board-facing.",
    "- If the board gives you an actionable summary or asks you to own follow-up work, create or update a Paperclip issue for yourself instead of leaving it as only chat.",
    "- Prefer a hidden `issue_create` paperclip-action block for new work instead of shelling out to the control plane.",
    "- When you create a new issue from this chat, choose a concrete title/description, assign it to yourself when appropriate, and mention the issue identifier back in your reply.",
    "- After creating the issue, begin the work immediately if you have enough context, update the issue as you progress, and send a concise follow-up in this chat when the work is complete or blocked.",
    "- Do not ask another agent to create an issue for work that you own unless the board explicitly told that other agent to own project management for it.",
    "- If asked to relay a short message to another agent, emit a hidden paperclip-action block so Paperclip can deliver it in-process.",
    "- Your visible reply for a relay should be only the exact outbound message, starting with the target mention (example: `@Zuko hi from Engineer.`).",
    "- Do not add delivery narration, debugging notes, or status paragraphs to that visible relay reply.",
    "- If delivery truly fails and you must mention it, keep it to one short sentence after the message.",
    "- Prefer PAPERCLIP_BRIDGE_COMMAND over raw curl or direct localhost HTTP.",
    ...(mentionHints.length > 0
      ? [
        "Mentioned agents in this message:",
        ...mentionHints,
        "If you need to relay a message to one of them, use the exact targetAgentId from the list above in your hidden paperclip-action block.",
      ]
      : []),
    "- For direct agent sends, use this exact hidden block format anywhere in your response when you want Paperclip to perform the send:",
    "[[paperclip-action]]",
    "{\"type\":\"agent_conversation_send\",\"targetAgentId\":\"<agent-id>\",\"body\":\"<message text>\"}",
    "[[/paperclip-action]]",
    "- For issue creation, use this exact hidden block format when a board request should become a new tracked task for you:",
    "[[paperclip-action]]",
    "{\"type\":\"issue_create\",\"title\":\"<issue title>\",\"description\":\"<issue description>\",\"priority\":\"high\",\"status\":\"todo\"}",
    "[[/paperclip-action]]",
    "[[/paperclip-agent-chat-guidance]]",
    body.trim(),
  ].join("\n");
}

async function resolveMentionedAgentHints(
  db: Db,
  companyId: string,
  body: string,
): Promise<string[]> {
  const tokens = extractMentionTokens(body);
  if (tokens.length === 0) return [];
  const companyAgents = await db
    .select({
      id: agentsTable.id,
      name: agentsTable.name,
    })
    .from(agentsTable)
    .where(and(eq(agentsTable.companyId, companyId), ne(agentsTable.status, "terminated")));

  const hints: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeAgentUrlKey(token);
    const match = companyAgents.find(
      (entry) => entry.name === token || normalizeAgentUrlKey(entry.name) === normalized,
    );
    if (!match) continue;
    hints.push(`- @${match.name} => targetAgentId=${match.id}`);
  }
  return hints;
}

function createRuntimeLink(
  agent: NonNullable<Awaited<ReturnType<ReturnType<typeof agentService>["getById"]>>>,
  runtimeKind: "codex" | "openclaw",
  externalConversationId: string,
): IssueRuntimeLink {
  return {
    issueId: agentChatTaskKey(agent.id),
    companyId: agent.companyId,
    runtimeKind,
    externalConversationId,
    externalConversationLabel: agent.name,
    metadataJson: {
      scope: "agent_chat",
      agentId: agent.id,
    },
    linkedByAgentId: null,
    linkedByUserId: null,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

const REUSABLE_AGENT_CREATED_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
] as const;

async function findReusableAgentCreatedIssue(
  db: Db,
  companyId: string,
  sourceAgentId: string,
  assigneeAgentId: string | null,
  title: string,
  requestText: string | null,
) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return null;

  const assigneeCondition = assigneeAgentId
    ? eq(issuesTable.assigneeAgentId, assigneeAgentId)
    : isNull(issuesTable.assigneeAgentId);

  const rows = await db
    .select()
    .from(issuesTable)
    .where(and(
      eq(issuesTable.companyId, companyId),
      eq(issuesTable.createdByAgentId, sourceAgentId),
      assigneeCondition,
      eq(issuesTable.title, normalizedTitle),
      inArray(issuesTable.status, [...REUSABLE_AGENT_CREATED_ISSUE_STATUSES]),
      isNull(issuesTable.hiddenAt),
    ))
    .orderBy(desc(issuesTable.createdAt))
    .limit(10);

  if (!requestText) return rows[0] ?? null;

  const exactMatch = rows.find((row) => {
    const context =
      row.creationContext && typeof row.creationContext === "object" && !Array.isArray(row.creationContext)
        ? row.creationContext as Record<string, unknown>
        : null;
    return typeof context?.requestText === "string" && context.requestText === requestText;
  });

  return exactMatch ?? rows[0] ?? null;
}

function emptySnapshot(
  agent: NonNullable<Awaited<ReturnType<ReturnType<typeof agentService>["getById"]>>>,
  runtimeKind: "codex" | "openclaw" | null,
  externalConversationId: string | null,
  opts?: {
    sourceStatus?: IssueConversationSnapshot["sourceStatus"];
    error?: string | null;
  },
): IssueConversationSnapshot {
  const runtimeLink =
    runtimeKind && externalConversationId
      ? createRuntimeLink(agent, runtimeKind, externalConversationId)
      : null;
  return {
    issueId: agentChatTaskKey(agent.id),
    runtimeLink,
    sourceStatus: opts?.sourceStatus ?? "ok",
    activeTurnId: null,
    isStreaming: false,
    runtimeInfo: runtimeLink && runtimeKind
      ? {
        runtimeKind,
        externalConversationId: runtimeLink.externalConversationId,
        externalConversationLabel: agent.name,
        model: null,
        provider: runtimeKind === "codex" ? "openai" : "openclaw",
        thinking: null,
        reasoning: null,
        sessionKey: runtimeKind === "openclaw" ? runtimeLink.externalConversationId : null,
        metadataJson: runtimeLink.metadataJson ?? null,
      }
      : null,
    pendingApprovals: [],
    items: [],
    error: opts?.error ?? null,
  };
}

function summarizeIssueRow(row: {
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}) {
  const ident = row.identifier ? `${row.identifier}: ` : "";
  return `- ${ident}${row.title} (${row.status}, ${row.priority})`;
}

function summarizeRoutineRow(row: {
  title: string;
  status: string;
  priority: string;
}) {
  return `- ${row.title} (${row.status}, ${row.priority})`;
}

async function buildAgentChatBootstrap(
  db: Db,
  agent: NonNullable<Awaited<ReturnType<ReturnType<typeof agentService>["getById"]>>>,
  body: string,
) {
  const [company, directReports, assignedIssues, companyOpenIssues, agentRoutines, companyAgents] = await Promise.all([
    db
      .select({ name: companies.name, issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, agent.companyId))
      .then((rows) => rows[0] ?? null),
    db
      .select({ total: count() })
      .from(agentsTable)
      .where(and(eq(agentsTable.companyId, agent.companyId), eq(agentsTable.reportsTo, agent.id)))
      .then((rows) => Number(rows[0]?.total ?? 0)),
    db
      .select({
        identifier: issuesTable.identifier,
        title: issuesTable.title,
        status: issuesTable.status,
        priority: issuesTable.priority,
      })
      .from(issuesTable)
      .where(
        and(
          eq(issuesTable.companyId, agent.companyId),
          eq(issuesTable.assigneeAgentId, agent.id),
          inArray(issuesTable.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
        ),
      )
      .orderBy(desc(issuesTable.updatedAt))
      .limit(12),
    db
      .select({
        identifier: issuesTable.identifier,
        title: issuesTable.title,
        status: issuesTable.status,
        priority: issuesTable.priority,
      })
      .from(issuesTable)
      .where(
        and(
          eq(issuesTable.companyId, agent.companyId),
          isNotNull(issuesTable.assigneeAgentId),
          ne(issuesTable.status, "done"),
          ne(issuesTable.status, "cancelled"),
          ne(issuesTable.status, "hidden"),
        ),
      )
      .orderBy(desc(issuesTable.updatedAt))
      .limit(20),
    db
      .select({
        title: routines.title,
        status: routines.status,
        priority: routines.priority,
      })
      .from(routines)
      .where(and(eq(routines.companyId, agent.companyId), eq(routines.assigneeAgentId, agent.id)))
      .orderBy(desc(routines.updatedAt))
      .limit(10),
    db
      .select({
        id: agentsTable.id,
        name: agentsTable.name,
        role: agentsTable.role,
        title: agentsTable.title,
        capabilities: agentsTable.capabilities,
      })
      .from(agentsTable)
      .where(and(eq(agentsTable.companyId, agent.companyId), ne(agentsTable.status, "terminated")))
      .orderBy(agentsTable.name),
  ]);

  const assignedIssueLines =
    assignedIssues.length > 0
      ? assignedIssues.map(summarizeIssueRow).join("\n")
      : "- none";
  const companyIssueLines =
    companyOpenIssues.length > 0
      ? companyOpenIssues.map(summarizeIssueRow).join("\n")
      : "- none";
  const routineLines =
    agentRoutines.length > 0
      ? agentRoutines.map(summarizeRoutineRow).join("\n")
      : "- none";
  const companyAgentLines =
    companyAgents.length > 0
      ? companyAgents
        .map((entry) =>
          `- ${entry.name} [id:${entry.id}] (${entry.role}${entry.title ? ` • ${entry.title}` : ""})${entry.capabilities ? ` — ${entry.capabilities}` : ""}`,
        )
        .join("\n")
      : "- none";

  const paperclipEnv = buildPaperclipEnv(agent);
  const paperclipApiUrl = paperclipEnv.PAPERCLIP_API_URL;
  const paperclipBridgeCommand =
    typeof paperclipEnv.PAPERCLIP_BRIDGE_COMMAND === "string" && paperclipEnv.PAPERCLIP_BRIDGE_COMMAND.trim().length > 0
      ? paperclipEnv.PAPERCLIP_BRIDGE_COMMAND.trim()
      : "paperclipai api";
  const accessSection =
    agent.adapterType === "openclaw_gateway"
      ? [
        "Control-plane access:",
        `- PAPERCLIP_API_URL=${paperclipApiUrl}`,
        `- Preferred bridge command: ${paperclipBridgeCommand}`,
        "- Load PAPERCLIP_API_KEY from ~/.openclaw/workspace/paperclip-claimed-api-key.json when you need to act in Paperclip.",
        "- Prefer the Paperclip bridge command over raw curl when it is available.",
      ]
      : [
        "Control-plane access:",
        `- PAPERCLIP_API_URL=${paperclipApiUrl}`,
        `- Preferred bridge command: ${paperclipBridgeCommand}`,
        "- PAPERCLIP_API_KEY is injected into your local direct-chat runtime when supported.",
        "- Prefer the Paperclip bridge command over raw curl when it is available.",
      ];

  return [
    "[[paperclip-agent-chat-bootstrap]]",
    "Direct board-to-agent chat inside Paperclip.",
    "",
    "Identity:",
    `- Agent: ${agent.name}`,
    `- Role: ${agent.role}`,
    agent.title ? `- Title: ${agent.title}` : null,
    company?.name ? `- Company: ${company.name}` : null,
    agent.capabilities ? `- Responsibilities: ${agent.capabilities}` : null,
    `- Direct reports: ${directReports}`,
    "",
    "Current assigned open issues:",
    assignedIssueLines,
    "",
    "Current company open issues:",
    companyIssueLines,
    "",
    "Current routines assigned to you:",
    routineLines,
    "",
    "Agent directory:",
    companyAgentLines,
    "",
    ...accessSection,
    "",
    "Actionable APIs:",
    `- Read self/company work: ${paperclipBridgeCommand} get /api/agents/me --json and ${paperclipBridgeCommand} get /api/companies/${agent.companyId}/issues?assigneeAgentId=${agent.id}\\&status=todo,in_progress,blocked --json`,
    `- Create issue: ${paperclipBridgeCommand} post /api/companies/${agent.companyId}/issues --body '{...}' --json`,
    `- Update or reassign issue: ${paperclipBridgeCommand} patch /api/issues/{issueId} --body '{...}' --json`,
    `- Create routine for yourself: ${paperclipBridgeCommand} post /api/companies/${agent.companyId}/routines --body '{...}' --json`,
    `- Update your routine or triggers: ${paperclipBridgeCommand} patch /api/routines/{routineId} --body '{...}' --json and ${paperclipBridgeCommand} post /api/routines/{routineId}/triggers --body '{...}' --json`,
    `- Update yourself when asked: ${paperclipBridgeCommand} patch /api/agents/${agent.id} --body '{...}' --json`,
    `- Talk to another agent directly: ${paperclipBridgeCommand} post /api/agents/{otherAgentId}/conversation/send?companyId=${agent.companyId} --body '{\"body\":\"hello\"}' --json`,
    `- Read another agent conversation: ${paperclipBridgeCommand} get /api/agents/{otherAgentId}/conversation?companyId=${agent.companyId}\\&limit=100 --json`,
    "",
    "Coordination rules:",
    "- If you need the latest information from another agent, talk to them directly through the agent conversation API, then summarize the answer back.",
    "- Use direct agent chat for responsibilities, status, and coordination; use issue updates/comments when tracked work should change state.",
    "- If the board gives you a summary, decision, or ask that should become tracked work, turn it into a Paperclip issue for yourself rather than leaving it only in chat.",
    "- When you create a new issue from chat, tell the board the identifier, do the work from that issue, and return here with the outcome when you are done or blocked.",
    "- When you change routines, issues, or your own configuration, tell the board exactly what changed and why.",
    "- Do not use raw curl or direct localhost HTTP when the Paperclip bridge command is available.",
    "- In board/meeting chat, do not expose internal command searches, approvals, or debugging steps unless explicitly asked.",
    "- If the board asks you to send a short message to another agent, deliver it if possible and then reply with the exact delivered message or a one-sentence failure note.",
    "- If you receive a board-meeting FYI or a forwarded message where you are only mentioned, stay silent unless you are directly asked, the board addresses you next, or you have concrete relevant information.",
    "",
    "Expectations:",
    "- This chat is for discussing your responsibilities, current work, future tasks, routines, and self-configuration.",
    "- If asked to change your own setup, routines, or tasks and you have Paperclip API/tool access in your runtime, make the change and explain what changed briefly.",
    "- Prefer concise, board-facing answers over process narration.",
    "- If you need fresher detail than this snapshot, inspect the Paperclip control plane from your runtime instead of guessing.",
    "[[/paperclip-agent-chat-bootstrap]]",
    body.trim(),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

async function deriveCodexChatCwd(
  heartbeat: ReturnType<typeof heartbeatService>,
  agent: NonNullable<Awaited<ReturnType<ReturnType<typeof agentService>["getById"]>>>,
) {
  const sessions = await heartbeat.listTaskSessions(agent.id);
  for (const session of sessions) {
    const params = (session.sessionParamsJson ?? null) as Record<string, unknown> | null;
    const candidate =
      readNonEmptyString(params?.cwd) ??
      readNonEmptyString(params?.agentHome) ??
      readNonEmptyString(params?.worktreePath);
    if (candidate) return candidate;
  }
  return process.cwd();
}

export function agentConversationRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);
  const issues = issueService(db);
  const secrets = secretService(db);
  const conversationLog = logger.child({ service: "agent-conversations" });

  async function sendDirectAgentMessageInternal(
    targetAgent: NonNullable<Awaited<ReturnType<ReturnType<typeof agentService>["getById"]>>>,
    body: string,
    sourceAgentId: string | null,
  ) {
    const taskKey = agentChatTaskKey(targetAgent.id);
    const taskSession = (await heartbeat.listTaskSessions(targetAgent.id)).find(
      (session) => session.taskKey === taskKey && session.adapterType === targetAgent.adapterType,
    ) ?? null;
    const taskSessionParams = ((taskSession?.sessionParamsJson ?? null) as Record<string, unknown> | null) ?? {};
    const protocolVersion = readDirectChatProtocolVersion(taskSessionParams.directChatProtocolVersion);
    const hasCurrentProtocol = protocolVersion === DIRECT_CHAT_PROTOCOL_VERSION;
    const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir ?? null;
    const openclawHome = readConfigFile()?.runtimeSources?.openclaw?.homeDir ?? null;
    conversationLog.info({
      flow: "agent-conversation",
      step: "internal-dispatch-start",
      sourceAgentId,
      targetAgentId: targetAgent.id,
      targetAgentName: targetAgent.name,
      targetAdapterType: targetAgent.adapterType,
      taskKey,
      hasExistingTaskSession: taskSession != null,
      hasCurrentProtocol,
      body: summarizeConversationBody(body),
    }, "dispatching internal agent conversation");

    if (targetAgent.adapterType === "openclaw_gateway") {
      if (!openclawHome) {
        throw new Error("OpenClaw runtime source is not configured.");
      }
      const { config: runtimeAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
        targetAgent.companyId,
        (targetAgent.adapterConfig ?? {}) as Record<string, unknown>,
      );
      const sessionKey =
        (hasCurrentProtocol
          ? readNonEmptyString(taskSessionParams.sessionKey)
          : null) ??
        `paperclip:agent:${targetAgent.id}`;
      const runtimeLink = createRuntimeLink(targetAgent, "openclaw", sessionKey);
      const liveSession = getOrCreateOpenClawLiveConversationSession({
        issueId: taskKey,
        sessionKey,
        openclawHome,
        adapterConfig: runtimeAdapterConfig,
      });
      const snapshotBefore = await liveSession.snapshot(taskKey, runtimeLink, 5);
      const mentionHints = await resolveMentionedAgentHints(db, targetAgent.companyId, body);
      const message =
        snapshotBefore.items.length === 0
          ? await buildAgentChatBootstrap(db, targetAgent, body)
          : buildAgentChatTurnGuidance(body, mentionHints);
      await liveSession.send(message);
      await heartbeat.setTaskSession({
        companyId: targetAgent.companyId,
        agentId: targetAgent.id,
        adapterType: targetAgent.adapterType,
        taskKey,
        sessionParamsJson: {
          sessionKey,
          directChatProtocolVersion: DIRECT_CHAT_PROTOCOL_VERSION,
        },
        sessionDisplayId: targetAgent.name,
      });
      await logActivity(db, {
        companyId: targetAgent.companyId,
        actorType: "agent",
        actorId: sourceAgentId ?? targetAgent.id,
        agentId: sourceAgentId,
        runId: null,
        action: "agent.conversation_sent",
        entityType: "agent",
        entityId: targetAgent.id,
        details: {
          bodySnippet: body.slice(0, 120),
          taskKey,
          runtimeKind: "openclaw",
          sourceAgentId,
        },
      });
      conversationLog.info({
        flow: "agent-conversation",
        step: "internal-dispatch-complete",
        runtimeKind: "openclaw",
        sourceAgentId,
        targetAgentId: targetAgent.id,
        sessionKey,
      }, "internal agent conversation delivered");
      return;
    }

    if (targetAgent.adapterType === "codex_local") {
      if (!codexHome) {
        throw new Error("Codex runtime source is not configured.");
      }
      let threadId =
        hasCurrentProtocol
          ? readNonEmptyString(taskSessionParams.threadId) ??
            readNonEmptyString(taskSessionParams.sessionId)
          : null;
      const cwd = await deriveCodexChatCwd(heartbeat, targetAgent);
      if (!threadId) {
        const runtimeLink = createRuntimeLink(targetAgent, "codex", `pending:${targetAgent.id}`);
        const liveSession = getOrCreateCodexLiveConversationSession(
          taskKey,
          null,
          codexHome,
          buildLocalDirectChatEnv(targetAgent),
          {
            cwd,
            name: `${targetAgent.name} direct chat`,
          },
        );
        const snapshotBefore = await liveSession.snapshot(taskKey, runtimeLink, 5);
        const mentionHints = await resolveMentionedAgentHints(db, targetAgent.companyId, body);
        const message =
          snapshotBefore.items.length === 0
            ? await buildAgentChatBootstrap(db, targetAgent, body)
            : buildAgentChatTurnGuidance(body, mentionHints);
        await liveSession.send(message);
        threadId = liveSession.getCurrentThreadId();
        if (!threadId) {
          throw new Error("Failed to start direct Codex chat thread.");
        }
        await heartbeat.setTaskSession({
          companyId: targetAgent.companyId,
          agentId: targetAgent.id,
          adapterType: targetAgent.adapterType,
            taskKey,
            sessionParamsJson: {
              threadId,
              sessionId: threadId,
              cwd,
              directChatProtocolVersion: DIRECT_CHAT_PROTOCOL_VERSION,
            },
            sessionDisplayId: `${targetAgent.name} direct chat`,
          });
        conversationLog.info({
          flow: "agent-conversation",
          step: "internal-dispatch-thread-started",
          runtimeKind: "codex",
          sourceAgentId,
          targetAgentId: targetAgent.id,
          threadId,
          cwd,
        }, "started codex direct chat thread during internal dispatch");
      } else {
        const liveSession = getOrCreateCodexLiveConversationSession(
          taskKey,
          threadId,
          codexHome,
          buildLocalDirectChatEnv(targetAgent),
          {
            cwd,
            name: `${targetAgent.name} direct chat`,
          },
        );
        const runtimeLink = createRuntimeLink(targetAgent, "codex", threadId);
        const snapshotBefore = await liveSession.snapshot(taskKey, runtimeLink, 5);
        const mentionHints = await resolveMentionedAgentHints(db, targetAgent.companyId, body);
        const message =
          snapshotBefore.items.length === 0
            ? await buildAgentChatBootstrap(db, targetAgent, body)
            : buildAgentChatTurnGuidance(body, mentionHints);
        await liveSession.send(message);
        const currentThreadId = liveSession.getCurrentThreadId();
        if (currentThreadId && currentThreadId !== threadId) {
          await heartbeat.setTaskSession({
            companyId: targetAgent.companyId,
            agentId: targetAgent.id,
            adapterType: targetAgent.adapterType,
            taskKey,
            sessionParamsJson: {
              threadId: currentThreadId,
              sessionId: currentThreadId,
              cwd,
              directChatProtocolVersion: DIRECT_CHAT_PROTOCOL_VERSION,
            },
            sessionDisplayId: `${targetAgent.name} direct chat`,
          });
          conversationLog.info({
            flow: "agent-conversation",
            step: "internal-dispatch-thread-rotated",
            runtimeKind: "codex",
            sourceAgentId,
            targetAgentId: targetAgent.id,
            previousThreadId: threadId,
            currentThreadId,
            cwd,
          }, "codex direct chat thread changed during internal dispatch");
        }
      }

      await logActivity(db, {
        companyId: targetAgent.companyId,
        actorType: "agent",
        actorId: sourceAgentId ?? targetAgent.id,
        agentId: sourceAgentId,
        runId: null,
        action: "agent.conversation_sent",
        entityType: "agent",
        entityId: targetAgent.id,
        details: {
          bodySnippet: body.slice(0, 120),
          taskKey,
          runtimeKind: "codex",
          sourceAgentId,
        },
      });
      conversationLog.info({
        flow: "agent-conversation",
        step: "internal-dispatch-complete",
        runtimeKind: "codex",
        sourceAgentId,
        targetAgentId: targetAgent.id,
        threadId,
        cwd,
      }, "internal agent conversation delivered");
      return;
    }

    throw new Error(`Direct chat is not supported for adapter type ${targetAgent.adapterType}.`);
  }

  async function applyAssistantConversationActions(
    sourceAgent: NonNullable<Awaited<ReturnType<ReturnType<typeof agentService>["getById"]>>>,
    snapshot: IssueConversationSnapshot,
  ) {
    const taskKey = agentChatTaskKey(sourceAgent.id);
    const taskSession = (await heartbeat.listTaskSessions(sourceAgent.id)).find(
      (session) => session.taskKey === taskKey && session.adapterType === sourceAgent.adapterType,
    ) ?? null;
    const sessionParams = ((taskSession?.sessionParamsJson ?? null) as Record<string, unknown> | null) ?? {};
    const processed = new Set(
      Array.isArray(sessionParams.processedActionIds)
        ? sessionParams.processedActionIds.filter((value): value is string => typeof value === "string")
        : [],
    );
    let mutated = false;
    let discoveredActions = 0;
    let dispatchedActions = 0;
    let lastAssistantItem: IssueConversationSnapshot["items"][number] | null = null;
    let lastUserItem: IssueConversationSnapshot["items"][number] | null = null;

    const appendActionResult = (
      targetItem: IssueConversationSnapshot["items"][number] | null,
      result: Record<string, unknown>,
    ) => {
      if (!targetItem) return;
      const metadata =
        targetItem.metadataJson && typeof targetItem.metadataJson === "object" && !Array.isArray(targetItem.metadataJson)
          ? targetItem.metadataJson as Record<string, unknown>
          : {};
      const existingResults = Array.isArray(metadata.paperclipActionResults)
        ? metadata.paperclipActionResults.filter(
            (value): value is Record<string, unknown> =>
              typeof value === "object" && value !== null && !Array.isArray(value),
          )
        : [];
      targetItem.metadataJson = {
        ...metadata,
        paperclipActionResults: [...existingResults, result],
      };
    };

    for (const item of snapshot.items) {
      if (item.role === "user") {
        lastUserItem = item;
      }
      if (item.role === "assistant") {
        lastAssistantItem = item;
      }
      const metadata =
        item.metadataJson && typeof item.metadataJson === "object" && !Array.isArray(item.metadataJson)
          ? item.metadataJson as Record<string, unknown>
          : {};
      if (item.role === "assistant") {
        const rawActions = (metadata as Record<string, unknown>).paperclipActions;
        if (!Array.isArray(rawActions)) continue;
        const actionResults: Array<Record<string, unknown>> = [];
      for (let index = 0; index < rawActions.length; index += 1) {
        const action = rawActions[index];
        if (typeof action !== "object" || action === null || Array.isArray(action)) continue;
        const record = action as Record<string, unknown>;
        const actionId =
          (typeof record.id === "string" && record.id.trim()) || `${item.id}:${index}`;
        if (processed.has(actionId)) continue;
        if (record.type !== "agent_conversation_send" && record.type !== "issue_create") continue;
        discoveredActions += 1;
        if (record.type === "issue_create") {
          const title =
            typeof record.title === "string" && record.title.trim().length > 0
              ? record.title.trim()
              : null;
          if (!title) continue;
          const description =
            typeof record.description === "string" && record.description.trim().length > 0
              ? record.description.trim()
              : null;
          const priority =
            typeof record.priority === "string" && record.priority.trim().length > 0
              ? record.priority.trim()
              : "high";
          const status =
            typeof record.status === "string" && record.status.trim().length > 0
              ? record.status.trim()
              : "todo";
          const assigneeAgentId =
            typeof record.assigneeAgentId === "string" && record.assigneeAgentId.trim().length > 0
              ? record.assigneeAgentId.trim()
              : sourceAgent.id;
          const creationContext: IssueCreationContext = {
            sourceKind: "agent_chat",
            sourceAgentId: sourceAgent.id,
            sourceIssueId: null,
            sourceMessageId: item.id,
            sourceActionId: actionId,
            requestText: normalizeCreationContextText(lastUserItem?.text),
            reason: normalizeCreationContextText(description),
          };

          conversationLog.info({
            flow: "agent-conversation",
            step: "assistant-action-issue-create",
            sourceAgentId: sourceAgent.id,
            sourceAgentName: sourceAgent.name,
            itemId: item.id,
            actionId,
            title,
            assigneeAgentId,
            priority,
            status,
          }, "creating issue from assistant action");

          const reusableIssue = await findReusableAgentCreatedIssue(
            db,
            sourceAgent.companyId,
            sourceAgent.id,
            assigneeAgentId,
            title,
            creationContext.requestText,
          );
          if (reusableIssue) {
            conversationLog.info({
              flow: "agent-conversation",
              step: "assistant-action-issue-reused",
              sourceAgentId: sourceAgent.id,
              sourceAgentName: sourceAgent.name,
              itemId: item.id,
              actionId,
              issueIdentifier: reusableIssue.identifier,
              issueTitle: reusableIssue.title,
            }, "reused existing issue for assistant action");
          }
          const createdIssue = reusableIssue ?? await issues.create(sourceAgent.companyId, {
            title,
            description,
            assigneeAgentId,
            priority,
            status,
            createdByAgentId: sourceAgent.id,
            creationContext,
          });
          actionResults.push({
            actionId,
            type: "issue_create",
            issueId: createdIssue.id,
            issueIdentifier: createdIssue.identifier,
            issueTitle: createdIssue.title,
            assigneeAgentId: createdIssue.assigneeAgentId,
            status: createdIssue.status,
            mode: reusableIssue ? "reused_existing" : "created",
          });
          appendActionResult(item, actionResults[actionResults.length - 1]!);
          processed.add(actionId);
          mutated = true;
          dispatchedActions += 1;
          continue;
        }
        const targetAgentId =
          typeof record.targetAgentId === "string" && record.targetAgentId.trim().length > 0
            ? record.targetAgentId.trim()
            : null;
        const targetAgentName =
          typeof record.targetAgentName === "string" && record.targetAgentName.trim().length > 0
            ? record.targetAgentName.trim()
            : null;
        const body =
          typeof record.body === "string" && record.body.trim().length > 0
            ? record.body.trim()
            : null;
        if (!body) continue;
        let targetAgent =
          targetAgentId ? await agents.getById(targetAgentId) : null;
        if (!targetAgent && targetAgentName) {
          const allAgentCandidates = await db
            .select({
              id: agentsTable.id,
              name: agentsTable.name,
            })
            .from(agentsTable)
            .where(and(eq(agentsTable.companyId, sourceAgent.companyId), ne(agentsTable.status, "terminated")));
          const match =
            allAgentCandidates.find(
              (entry) => entry.name === targetAgentName || normalizeAgentUrlKey(entry.name) === normalizeAgentUrlKey(targetAgentName),
            ) ??
            null;
          targetAgent = match ? await agents.getById(match.id) : null;
        }
        if (!targetAgent) {
          conversationLog.warn({
            flow: "agent-conversation",
            step: "assistant-action-unresolved",
            sourceAgentId: sourceAgent.id,
            sourceAgentName: sourceAgent.name,
            itemId: item.id,
            actionId,
            targetAgentId,
            targetAgentName,
            body: summarizeConversationBody(body),
          }, "assistant action could not resolve a target agent");
          continue;
        }
        conversationLog.info({
          flow: "agent-conversation",
          step: "assistant-action-dispatch",
          sourceAgentId: sourceAgent.id,
          sourceAgentName: sourceAgent.name,
          itemId: item.id,
          actionId,
          targetAgentId: targetAgent.id,
          targetAgentName: targetAgent.name,
          body: summarizeConversationBody(body),
        }, "dispatching assistant action");
        await sendDirectAgentMessageInternal(targetAgent, body, sourceAgent.id);
        actionResults.push({
          actionId,
          type: "agent_conversation_send",
          targetAgentId: targetAgent.id,
          targetAgentName: targetAgent.name,
          body,
          status: "delivered",
        });
        appendActionResult(item, actionResults[actionResults.length - 1]!);
        processed.add(actionId);
        mutated = true;
        dispatchedActions += 1;
      }
        continue;
      }

      if (item.role !== "tool") continue;
      const toolMetadata =
        item.metadataJson && typeof item.metadataJson === "object" && !Array.isArray(item.metadataJson)
          ? item.metadataJson as Record<string, unknown>
          : null;
      const command = typeof toolMetadata?.command === "string" ? toolMetadata.command : null;
      const status = typeof toolMetadata?.status === "string" ? toolMetadata.status : null;
      if (!command || (status !== "declined" && status !== "failed")) continue;
      const fallback = parseBridgeIssueCreateCommand(command);
      if (!fallback) continue;
      const actionId = `tool:${item.id}`;
      if (processed.has(actionId)) continue;
      const assigneeAgentId = fallback.payload.assigneeAgentId ?? sourceAgent.id;
      const creationContext: IssueCreationContext = {
        sourceKind: "agent_chat_fallback",
        sourceAgentId: sourceAgent.id,
        sourceIssueId: null,
        sourceMessageId: lastAssistantItem?.id ?? item.id,
        sourceActionId: actionId,
        requestText: normalizeCreationContextText(lastUserItem?.text),
        reason: normalizeCreationContextText(fallback.payload.description),
      };
      const reusableIssue = await findReusableAgentCreatedIssue(
        db,
        sourceAgent.companyId,
        sourceAgent.id,
        assigneeAgentId,
        fallback.payload.title,
        creationContext.requestText,
      );
      if (reusableIssue) {
        conversationLog.info({
          flow: "agent-conversation",
          step: "tool-command-issue-reused",
          sourceAgentId: sourceAgent.id,
          sourceAgentName: sourceAgent.name,
          itemId: item.id,
          actionId,
          issueIdentifier: reusableIssue.identifier,
          issueTitle: reusableIssue.title,
        }, "reused existing issue for declined bridge fallback");
      }
      const createdIssue = reusableIssue ?? await issues.create(sourceAgent.companyId, {
        ...fallback.payload,
        assigneeAgentId,
        createdByAgentId: sourceAgent.id,
        creationContext,
      });
      appendActionResult(lastAssistantItem, {
        actionId,
        type: "issue_create",
        issueId: createdIssue.id,
        issueIdentifier: createdIssue.identifier,
        issueTitle: createdIssue.title,
        assigneeAgentId: createdIssue.assigneeAgentId,
        status: createdIssue.status,
        mode: reusableIssue ? "reused_existing" : "created",
      });
      conversationLog.info({
        flow: "agent-conversation",
        step: "tool-command-issue-create-fallback",
        sourceAgentId: sourceAgent.id,
        sourceAgentName: sourceAgent.name,
        itemId: item.id,
        actionId,
        issueIdentifier: createdIssue.identifier,
        issueTitle: createdIssue.title,
        reusedExisting: reusableIssue != null,
      }, "created issue from declined bridge command");
      processed.add(actionId);
      mutated = true;
      dispatchedActions += 1;
    }

    if (discoveredActions > 0) {
      conversationLog.info({
        flow: "agent-conversation",
        step: "assistant-actions-scanned",
        sourceAgentId: sourceAgent.id,
        sourceAgentName: sourceAgent.name,
        discoveredActions,
        dispatchedActions,
        processedActionCount: processed.size,
        snapshotItemCount: snapshot.items.length,
      }, "scanned assistant actions from conversation snapshot");
    }

    if (!mutated || !taskSession) return;
    await heartbeat.setTaskSession({
      companyId: sourceAgent.companyId,
      agentId: sourceAgent.id,
      adapterType: sourceAgent.adapterType,
      taskKey,
      sessionParamsJson: {
        ...sessionParams,
        processedActionIds: Array.from(processed),
      },
      sessionDisplayId: taskSession.sessionDisplayId,
    });
    conversationLog.debug({
      flow: "agent-conversation",
      step: "assistant-actions-persisted",
      sourceAgentId: sourceAgent.id,
      sourceAgentName: sourceAgent.name,
      processedActionCount: processed.size,
      taskKey,
    }, "persisted processed assistant action ids");
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = rawId;
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/agents/:id/conversation", async (req, res) => {
    const id = req.params.id as string;
    const agent = await agents.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    const requestId = readRequestId((req as { id?: unknown }).id);

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 1000) : 100;
    const taskKey = agentChatTaskKey(agent.id);
    const taskSession = (await heartbeat.listTaskSessions(agent.id)).find(
      (session) => session.taskKey === taskKey && session.adapterType === agent.adapterType,
    ) ?? null;
    const taskSessionParams = ((taskSession?.sessionParamsJson ?? null) as Record<string, unknown> | null) ?? {};
    const protocolVersion = readDirectChatProtocolVersion(taskSessionParams.directChatProtocolVersion);
    const hasCurrentProtocol = protocolVersion === DIRECT_CHAT_PROTOCOL_VERSION;
    const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir ?? null;
    const openclawHome = readConfigFile()?.runtimeSources?.openclaw?.homeDir ?? null;

    if (agent.adapterType === "openclaw_gateway") {
      if (!openclawHome) {
        res.json(emptySnapshot(agent, "openclaw", `paperclip:agent:${agent.id}`, {
          sourceStatus: "source_unavailable",
          error: "OpenClaw runtime source is not configured.",
        }));
        return;
      }
      const { config: runtimeAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
        agent.companyId,
        (agent.adapterConfig ?? {}) as Record<string, unknown>,
      );
      const sessionKey =
        (hasCurrentProtocol
          ? readNonEmptyString(taskSessionParams.sessionKey)
          : null) ??
        `paperclip:agent:${agent.id}`;
      const runtimeLink = createRuntimeLink(agent, "openclaw", sessionKey);
      const liveSession = getOrCreateOpenClawLiveConversationSession({
        issueId: taskKey,
        sessionKey,
        openclawHome,
        adapterConfig: runtimeAdapterConfig,
      });
      const snapshot = await liveSession.snapshot(taskKey, runtimeLink, limit);
      await applyAssistantConversationActions(agent, snapshot);
      conversationLog.debug({
        flow: "agent-conversation",
        step: "snapshot-read",
        requestId,
        agentId: agent.id,
        agentName: agent.name,
        runtimeKind: "openclaw",
        itemCount: snapshot.items.length,
        isStreaming: snapshot.isStreaming,
        pendingApprovalCount: snapshot.pendingApprovals.length,
      }, "read direct chat snapshot");
      res.json(snapshot);
      return;
    }

    if (agent.adapterType === "codex_local") {
      const threadId =
        hasCurrentProtocol
          ? readNonEmptyString(taskSessionParams.threadId) ??
            readNonEmptyString(taskSessionParams.sessionId)
          : null;
      if (!codexHome) {
        res.json(emptySnapshot(agent, "codex", threadId ?? taskKey, {
          sourceStatus: "source_unavailable",
          error: "Codex runtime source is not configured.",
        }));
        return;
      }
      if (!threadId) {
        res.json(emptySnapshot(agent, "codex", taskKey));
        return;
      }
      const cwd = await deriveCodexChatCwd(heartbeat, agent);
      const runtimeLink = createRuntimeLink(agent, "codex", threadId);
      const liveSession = getOrCreateCodexLiveConversationSession(
        taskKey,
        threadId,
        codexHome,
        buildLocalDirectChatEnv(agent),
        {
          cwd,
          name: `${agent.name} direct chat`,
        },
      );
      const snapshot = await liveSession.snapshot(taskKey, runtimeLink, limit);
      await applyAssistantConversationActions(agent, snapshot);
      conversationLog.debug({
        flow: "agent-conversation",
        step: "snapshot-read",
        requestId,
        agentId: agent.id,
        agentName: agent.name,
        runtimeKind: "codex",
        threadId,
        itemCount: snapshot.items.length,
        isStreaming: snapshot.isStreaming,
        pendingApprovalCount: snapshot.pendingApprovals.length,
      }, "read direct chat snapshot");
      const currentThreadId = liveSession.getCurrentThreadId();
      if (currentThreadId && currentThreadId !== threadId) {
        await heartbeat.setTaskSession({
          companyId: agent.companyId,
          agentId: agent.id,
          adapterType: agent.adapterType,
          taskKey,
          sessionParamsJson: { threadId: currentThreadId, sessionId: currentThreadId, cwd },
          sessionDisplayId: `${agent.name} direct chat`,
        });
        res.json(await liveSession.snapshot(taskKey, createRuntimeLink(agent, "codex", currentThreadId), limit));
        return;
      }
      res.json(snapshot);
      return;
    }

    res.json(emptySnapshot(agent, null, null, {
      sourceStatus: "source_unavailable",
      error: `Direct chat is not yet supported for adapter type ${agent.adapterType}.`,
    }));
  });

  router.post("/agents/:id/conversation/send", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const agent = await agents.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    const actor = getActorInfo(req);
    const requestId = readRequestId((req as { id?: unknown }).id);
    const taskKey = agentChatTaskKey(agent.id);
    const taskSession = (await heartbeat.listTaskSessions(agent.id)).find(
      (session) => session.taskKey === taskKey && session.adapterType === agent.adapterType,
    ) ?? null;
    const taskSessionParams = ((taskSession?.sessionParamsJson ?? null) as Record<string, unknown> | null) ?? {};
    const protocolVersion = readDirectChatProtocolVersion(taskSessionParams.directChatProtocolVersion);
    const hasCurrentProtocol = protocolVersion === DIRECT_CHAT_PROTOCOL_VERSION;
    const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir ?? null;
    const openclawHome = readConfigFile()?.runtimeSources?.openclaw?.homeDir ?? null;
    conversationLog.info({
      flow: "agent-conversation",
      step: "send-request",
      requestId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorAgentId: actor.agentId,
      runId: actor.runId,
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
      taskKey,
      body: summarizeConversationBody(req.body.body),
      hasExistingTaskSession: taskSession != null,
      hasCurrentProtocol,
    }, "received direct chat send request");

    if (agent.adapterType === "openclaw_gateway") {
      if (!openclawHome) {
        res.status(409).json({ error: "OpenClaw runtime source is not configured." });
        return;
      }
      const { config: runtimeAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
        agent.companyId,
        (agent.adapterConfig ?? {}) as Record<string, unknown>,
      );
      const sessionKey =
        (hasCurrentProtocol
          ? readNonEmptyString(taskSessionParams.sessionKey)
          : null) ??
        `paperclip:agent:${agent.id}`;
      const runtimeLink = createRuntimeLink(agent, "openclaw", sessionKey);
      const liveSession = getOrCreateOpenClawLiveConversationSession({
        issueId: taskKey,
        sessionKey,
        openclawHome,
        adapterConfig: runtimeAdapterConfig,
      });
      const snapshotBefore = await liveSession.snapshot(taskKey, runtimeLink, 5);
      const mentionHints = await resolveMentionedAgentHints(db, agent.companyId, req.body.body);
      const message =
        snapshotBefore.items.length === 0
          ? await buildAgentChatBootstrap(db, agent, req.body.body)
          : buildAgentChatTurnGuidance(req.body.body, mentionHints);
      await liveSession.send(message);
        await heartbeat.setTaskSession({
          companyId: agent.companyId,
          agentId: agent.id,
          adapterType: agent.adapterType,
          taskKey,
          sessionParamsJson: { sessionKey, directChatProtocolVersion: DIRECT_CHAT_PROTOCOL_VERSION },
          sessionDisplayId: agent.name,
        });
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.conversation_sent",
        entityType: "agent",
        entityId: agent.id,
        details: {
          bodySnippet: req.body.body.slice(0, 120),
          taskKey,
          runtimeKind: "openclaw",
        },
      });
      res.status(201).json(await liveSession.snapshot(taskKey, runtimeLink, 100));
      conversationLog.info({
        flow: "agent-conversation",
        step: "send-request-complete",
        requestId,
        agentId: agent.id,
        agentName: agent.name,
        runtimeKind: "openclaw",
        sessionKey,
      }, "completed direct chat send request");
      return;
    }

    if (agent.adapterType === "codex_local") {
      if (!codexHome) {
        res.status(409).json({ error: "Codex runtime source is not configured." });
        return;
      }
      let threadId =
        hasCurrentProtocol
          ? readNonEmptyString(taskSessionParams.threadId) ??
            readNonEmptyString(taskSessionParams.sessionId)
          : null;
      if (!threadId) {
        const cwd = await deriveCodexChatCwd(heartbeat, agent);
        const runtimeLink = createRuntimeLink(agent, "codex", `pending:${agent.id}`);
        const liveSession = getOrCreateCodexLiveConversationSession(
          taskKey,
          null,
          codexHome,
          buildLocalDirectChatEnv(agent),
          {
            cwd,
            name: `${agent.name} direct chat`,
          },
        );
        const snapshotBefore = await liveSession.snapshot(taskKey, runtimeLink, 5);
        const mentionHints = await resolveMentionedAgentHints(db, agent.companyId, req.body.body);
        const message =
          snapshotBefore.items.length === 0
            ? await buildAgentChatBootstrap(db, agent, req.body.body)
            : buildAgentChatTurnGuidance(req.body.body, mentionHints);
        await liveSession.send(message);
        threadId = liveSession.getCurrentThreadId();
        if (!threadId) {
          throw new Error("Failed to start direct Codex chat thread.");
        }
        await heartbeat.setTaskSession({
          companyId: agent.companyId,
          agentId: agent.id,
          adapterType: agent.adapterType,
          taskKey,
          sessionParamsJson: {
            threadId,
            sessionId: threadId,
            cwd,
            directChatProtocolVersion: DIRECT_CHAT_PROTOCOL_VERSION,
          },
          sessionDisplayId: `${agent.name} direct chat`,
        });
        await logActivity(db, {
          companyId: agent.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "agent.conversation_sent",
          entityType: "agent",
          entityId: agent.id,
          details: {
            bodySnippet: req.body.body.slice(0, 120),
            taskKey,
            runtimeKind: "codex",
          },
        });
        const snapshot = await liveSession.snapshot(taskKey, createRuntimeLink(agent, "codex", threadId), 100);
        await applyAssistantConversationActions(agent, snapshot);
        conversationLog.info({
          flow: "agent-conversation",
          step: "send-request-complete",
          requestId,
          agentId: agent.id,
          agentName: agent.name,
          runtimeKind: "codex",
          threadId,
          itemCount: snapshot.items.length,
          isStreaming: snapshot.isStreaming,
        }, "completed direct chat send request");
        res.status(201).json(snapshot);
        return;
      }
      const runtimeLink = createRuntimeLink(agent, "codex", threadId);
      const cwd = await deriveCodexChatCwd(heartbeat, agent);
      const liveSession = getOrCreateCodexLiveConversationSession(
        taskKey,
        threadId,
        codexHome,
        buildLocalDirectChatEnv(agent),
        {
          cwd,
          name: `${agent.name} direct chat`,
        },
      );
      const snapshotBefore = await liveSession.snapshot(taskKey, runtimeLink, 5);
      const mentionHints = await resolveMentionedAgentHints(db, agent.companyId, req.body.body);
      const message =
        snapshotBefore.items.length === 0
          ? await buildAgentChatBootstrap(db, agent, req.body.body)
          : buildAgentChatTurnGuidance(req.body.body, mentionHints);
      await liveSession.send(message);
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.conversation_sent",
        entityType: "agent",
        entityId: agent.id,
        details: {
          bodySnippet: req.body.body.slice(0, 120),
          taskKey,
          runtimeKind: "codex",
        },
      });
      const currentThreadId = liveSession.getCurrentThreadId();
        if (currentThreadId && currentThreadId !== threadId) {
          await heartbeat.setTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey,
            sessionParamsJson: {
              threadId: currentThreadId,
              sessionId: currentThreadId,
              cwd,
              directChatProtocolVersion: DIRECT_CHAT_PROTOCOL_VERSION,
            },
            sessionDisplayId: `${agent.name} direct chat`,
          });
        }
      const snapshot = await liveSession.snapshot(
        taskKey,
        createRuntimeLink(agent, "codex", currentThreadId ?? threadId),
        100,
      );
      await applyAssistantConversationActions(agent, snapshot);
      conversationLog.info({
        flow: "agent-conversation",
        step: "send-request-complete",
        requestId,
        agentId: agent.id,
        agentName: agent.name,
        runtimeKind: "codex",
        threadId: currentThreadId ?? threadId,
        itemCount: snapshot.items.length,
        isStreaming: snapshot.isStreaming,
      }, "completed direct chat send request");
      res.status(201).json(snapshot);
      return;
    }

    res.status(409).json({ error: `Direct chat is not yet supported for adapter type ${agent.adapterType}.` });
  });

  router.post("/agents/:id/conversation/steer", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const agent = await agents.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    const actor = getActorInfo(req);
    const requestId = readRequestId((req as { id?: unknown }).id);
    const taskKey = agentChatTaskKey(agent.id);
    const taskSession = (await heartbeat.listTaskSessions(agent.id)).find(
      (session) => session.taskKey === taskKey && session.adapterType === agent.adapterType,
    ) ?? null;
    const taskSessionParams = ((taskSession?.sessionParamsJson ?? null) as Record<string, unknown> | null) ?? {};
    const protocolVersion = readDirectChatProtocolVersion(taskSessionParams.directChatProtocolVersion);
    const hasCurrentProtocol = protocolVersion === DIRECT_CHAT_PROTOCOL_VERSION;
    const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir ?? null;
    const openclawHome = readConfigFile()?.runtimeSources?.openclaw?.homeDir ?? null;
    conversationLog.info({
      flow: "agent-conversation",
      step: "steer-request",
      requestId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorAgentId: actor.agentId,
      runId: actor.runId,
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
      taskKey,
      body: summarizeConversationBody(req.body.body),
    }, "received direct chat steer request");

    if (agent.adapterType === "openclaw_gateway") {
      if (!openclawHome) {
        res.status(409).json({ error: "OpenClaw runtime source is not configured." });
        return;
      }
      const sessionKey =
        (hasCurrentProtocol
          ? readNonEmptyString(taskSessionParams.sessionKey)
          : null) ??
        `paperclip:agent:${agent.id}`;
      const runtimeLink = createRuntimeLink(agent, "openclaw", sessionKey);
      const { config: runtimeAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
        agent.companyId,
        (agent.adapterConfig ?? {}) as Record<string, unknown>,
      );
      const liveSession = getOrCreateOpenClawLiveConversationSession({
        issueId: taskKey,
        sessionKey,
        openclawHome,
        adapterConfig: runtimeAdapterConfig,
      });
      const mentionHints = await resolveMentionedAgentHints(db, agent.companyId, req.body.body);
      await liveSession.steer(buildAgentChatTurnGuidance(req.body.body, mentionHints));
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.conversation_steered",
        entityType: "agent",
        entityId: agent.id,
        details: { taskKey, bodySnippet: req.body.body.slice(0, 120) },
      });
      const snapshot = await liveSession.snapshot(taskKey, runtimeLink, 100);
      await applyAssistantConversationActions(agent, snapshot);
      conversationLog.info({
        flow: "agent-conversation",
        step: "steer-request-complete",
        requestId,
        agentId: agent.id,
        agentName: agent.name,
        runtimeKind: "openclaw",
        itemCount: snapshot.items.length,
        isStreaming: snapshot.isStreaming,
      }, "completed direct chat steer request");
      res.json(snapshot);
      return;
    }

    if (agent.adapterType === "codex_local") {
      const threadId =
        hasCurrentProtocol
          ? readNonEmptyString(taskSessionParams.threadId) ??
            readNonEmptyString(taskSessionParams.sessionId)
          : null;
      if (!threadId || !codexHome) {
        res.status(409).json({ error: "No active codex direct chat session to steer." });
        return;
      }
      const runtimeLink = createRuntimeLink(agent, "codex", threadId);
      const liveSession = getOrCreateCodexLiveConversationSession(
        taskKey,
        threadId,
        codexHome,
        buildLocalDirectChatEnv(agent),
      );
      const mentionHints = await resolveMentionedAgentHints(db, agent.companyId, req.body.body);
      await liveSession.steer(buildAgentChatTurnGuidance(req.body.body, mentionHints));
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.conversation_steered",
        entityType: "agent",
        entityId: agent.id,
        details: { taskKey, bodySnippet: req.body.body.slice(0, 120) },
      });
      const snapshot = await liveSession.snapshot(taskKey, runtimeLink, 100);
      await applyAssistantConversationActions(agent, snapshot);
      conversationLog.info({
        flow: "agent-conversation",
        step: "steer-request-complete",
        requestId,
        agentId: agent.id,
        agentName: agent.name,
        runtimeKind: "codex",
        threadId,
        itemCount: snapshot.items.length,
        isStreaming: snapshot.isStreaming,
      }, "completed direct chat steer request");
      res.json(snapshot);
      return;
    }

    res.status(409).json({ error: `Direct chat is not yet supported for adapter type ${agent.adapterType}.` });
  });

  router.post("/agents/:id/conversation/interrupt", async (req, res) => {
    const id = req.params.id as string;
    const agent = await agents.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    const actor = getActorInfo(req);
    const taskKey = agentChatTaskKey(agent.id);
    const taskSession = (await heartbeat.listTaskSessions(agent.id)).find(
      (session) => session.taskKey === taskKey && session.adapterType === agent.adapterType,
    ) ?? null;
    const taskSessionParams = ((taskSession?.sessionParamsJson ?? null) as Record<string, unknown> | null) ?? {};
    const protocolVersion = readDirectChatProtocolVersion(taskSessionParams.directChatProtocolVersion);
    const hasCurrentProtocol = protocolVersion === DIRECT_CHAT_PROTOCOL_VERSION;
    const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir ?? null;
    const openclawHome = readConfigFile()?.runtimeSources?.openclaw?.homeDir ?? null;

    if (agent.adapterType === "openclaw_gateway") {
      if (!openclawHome) {
        res.status(409).json({ error: "OpenClaw runtime source is not configured." });
        return;
      }
      const sessionKey =
        (hasCurrentProtocol
          ? readNonEmptyString(taskSessionParams.sessionKey)
          : null) ??
        `paperclip:agent:${agent.id}`;
      const runtimeLink = createRuntimeLink(agent, "openclaw", sessionKey);
      const { config: runtimeAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
        agent.companyId,
        (agent.adapterConfig ?? {}) as Record<string, unknown>,
      );
      const liveSession =
        getExistingOpenClawLiveConversationSession(taskKey, sessionKey, openclawHome) ??
        getOrCreateOpenClawLiveConversationSession({
          issueId: taskKey,
          sessionKey,
          openclawHome,
          adapterConfig: runtimeAdapterConfig,
        });
      await liveSession.interrupt();
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.conversation_interrupted",
        entityType: "agent",
        entityId: agent.id,
        details: { taskKey },
      });
      res.json(await liveSession.snapshot(taskKey, runtimeLink, 100));
      return;
    }

    if (agent.adapterType === "codex_local") {
      const threadId =
        hasCurrentProtocol
          ? readNonEmptyString(taskSessionParams.threadId) ??
            readNonEmptyString(taskSessionParams.sessionId)
          : null;
      if (!threadId || !codexHome) {
        res.status(409).json({ error: "No active codex direct chat session to interrupt." });
        return;
      }
      const runtimeLink = createRuntimeLink(agent, "codex", threadId);
      const liveSession = getExistingCodexLiveConversationSession(taskKey, threadId, codexHome);
      if (!liveSession) {
        res.status(409).json({ error: "No active codex direct chat session to interrupt." });
        return;
      }
      await liveSession.interrupt();
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.conversation_interrupted",
        entityType: "agent",
        entityId: agent.id,
        details: { taskKey },
      });
      res.json(await liveSession.snapshot(taskKey, runtimeLink, 100));
      return;
    }

    res.status(409).json({ error: `Direct chat is not yet supported for adapter type ${agent.adapterType}.` });
  });

  router.post(
    "/agents/:id/conversation/approvals/:requestId/resolve",
    validate(resolveIssueConversationApprovalSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const requestId = req.params.requestId as string;
      const agent = await agents.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      assertCompanyAccess(req, agent.companyId);
      if (agent.adapterType !== "codex_local") {
        res.status(409).json({ error: "Only codex direct chats currently expose approval resolution." });
        return;
      }

      const taskKey = agentChatTaskKey(agent.id);
      const taskSession = (await heartbeat.listTaskSessions(agent.id)).find(
        (session) => session.taskKey === taskKey && session.adapterType === agent.adapterType,
      ) ?? null;
      const threadId =
        readNonEmptyString((taskSession?.sessionParamsJson ?? null as Record<string, unknown> | null)?.threadId) ??
        readNonEmptyString((taskSession?.sessionParamsJson ?? null as Record<string, unknown> | null)?.sessionId);
      const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir ?? null;
      if (!threadId || !codexHome) {
        res.status(409).json({ error: "No direct codex chat session available." });
        return;
      }

      const actor = getActorInfo(req);
      const runtimeLink = createRuntimeLink(agent, "codex", threadId);
      const liveSession = getOrCreateCodexLiveConversationSession(taskKey, threadId, codexHome);
      await liveSession.resolveApproval(requestId, req.body.decision);
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.conversation_approval_resolved",
        entityType: "agent",
        entityId: agent.id,
        details: { requestId, decision: req.body.decision, taskKey },
      });
      res.json(await liveSession.snapshot(taskKey, runtimeLink, 100));
    },
  );

  return router;
}
