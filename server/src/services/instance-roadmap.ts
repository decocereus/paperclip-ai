import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RoadmapItem } from "@paperclipai/shared";
import {
  createRoadmapItemSchema,
  roadmapItemSchema,
  updateRoadmapItemSchema,
  type CreateRoadmapItem,
  type UpdateRoadmapItem,
} from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { notFound } from "../errors.js";

const DEFAULT_ROADMAP_ITEMS: RoadmapItem[] = [
  {
    id: "linked-runtime-hardening",
    title: "Linked runtime hardening",
    description:
      "Finish Codex and OpenClaw live-session recovery, approvals, and end-to-end reliability so the control plane feels production-usable.",
    lane: "current",
    status: "in_progress",
    owner: "core",
    targetAt: "2026-04-10T12:00:00.000Z",
    source: "seed",
    tags: ["runtime", "codex", "openclaw"],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
  },
  {
    id: "mobile-supervision-mvp",
    title: "Mobile supervision MVP",
    description:
      "Ship the first mobile surface for monitoring runs, approving actions, interrupting agents, and steering conversations from the phone.",
    lane: "current",
    status: "planned",
    owner: "product",
    targetAt: "2026-04-18T12:00:00.000Z",
    source: "seed",
    tags: ["mobile", "supervision"],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
  },
  {
    id: "in-app-chat-surface",
    title: "In-app agent chat surface",
    description:
      "Add a direct chat UI inside Paperclip so OpenClaw, Codex, and future agents can be messaged without jumping to Telegram or external apps.",
    lane: "next",
    status: "planned",
    owner: "product",
    targetAt: "2026-04-28T12:00:00.000Z",
    source: "seed",
    tags: ["chat", "ux"],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
  },
  {
    id: "artifact-first-research",
    title: "Artifact-first research outputs",
    description:
      "Let agents produce durable docs and deliverables for research instead of leaving important outputs buried in transcripts and logs.",
    lane: "next",
    status: "planned",
    owner: "product",
    targetAt: "2026-05-05T12:00:00.000Z",
    source: "seed",
    tags: ["docs", "research", "artifacts"],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
  },
  {
    id: "knowledge-layer",
    title: "Knowledge layer and memory ingestion",
    description:
      "Introduce a first-class knowledge base for uploaded files, generated docs, agent memories, and personal/company context retrieval.",
    lane: "later",
    status: "idea",
    owner: "platform",
    targetAt: "2026-05-20T12:00:00.000Z",
    source: "seed",
    tags: ["memory", "knowledge"],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
  },
  {
    id: "manager-agent",
    title: "Manager agent with connectors",
    description:
      "Build a high-trust personal manager agent with memory, routines, email/calendar/docs access, and a richer execution model on top of the Paperclip control plane.",
    lane: "later",
    status: "idea",
    owner: "product",
    targetAt: "2026-06-03T12:00:00.000Z",
    source: "seed",
    tags: ["manager", "connectors", "personal-agent"],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
  },
  {
    id: "external-doc-sync",
    title: "External doc publishing and sync",
    description:
      "Add controlled export and sync paths for Notion and similar external knowledge tools once Paperclip-native docs and memory are stable.",
    lane: "later",
    status: "idea",
    owner: "platform",
    targetAt: "2026-06-17T12:00:00.000Z",
    source: "seed",
    tags: ["notion", "sync", "publishing"],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
  },
];

function roadmapFileSchema(input: unknown): RoadmapItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => roadmapItemSchema.safeParse(entry))
    .filter((entry) => entry.success)
    .map((entry) => entry.data);
}

function resolveRoadmapFilePath() {
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "roadmap.json");
}

function ensureRoadmapDir() {
  fs.mkdirSync(path.dirname(resolveRoadmapFilePath()), { recursive: true });
}

function sortRoadmap(items: RoadmapItem[]): RoadmapItem[] {
  return [...items].sort((left, right) => {
    const leftTime = left.targetAt ? new Date(left.targetAt).getTime() : Number.POSITIVE_INFINITY;
    const rightTime = right.targetAt ? new Date(right.targetAt).getTime() : Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

function readRawRoadmapFile(): RoadmapItem[] {
  const roadmapFilePath = resolveRoadmapFilePath();
  if (!fs.existsSync(roadmapFilePath)) {
    ensureRoadmapDir();
    fs.writeFileSync(roadmapFilePath, JSON.stringify(DEFAULT_ROADMAP_ITEMS, null, 2) + "\n", "utf8");
    return [...DEFAULT_ROADMAP_ITEMS];
  }

  try {
    return sortRoadmap(roadmapFileSchema(JSON.parse(fs.readFileSync(roadmapFilePath, "utf8"))));
  } catch {
    return sortRoadmap([...DEFAULT_ROADMAP_ITEMS]);
  }
}

function writeRawRoadmapFile(items: RoadmapItem[]) {
  ensureRoadmapDir();
  fs.writeFileSync(resolveRoadmapFilePath(), JSON.stringify(sortRoadmap(items), null, 2) + "\n", "utf8");
}

export function instanceRoadmapService() {
  return {
    list(): RoadmapItem[] {
      return readRawRoadmapFile();
    },

    create(input: CreateRoadmapItem): RoadmapItem {
      const payload = createRoadmapItemSchema.parse(input);
      const now = new Date().toISOString();
      const nextItem: RoadmapItem = {
        id: randomUUID(),
        title: payload.title,
        description: payload.description ?? null,
        lane: payload.lane,
        status: payload.status,
        owner: payload.owner ?? null,
        targetAt: payload.targetAt ?? null,
        source: "manual",
        tags: payload.tags,
        createdAt: now,
        updatedAt: now,
      };

      const items = readRawRoadmapFile();
      items.push(nextItem);
      writeRawRoadmapFile(items);
      return nextItem;
    },

    update(id: string, patch: UpdateRoadmapItem): RoadmapItem {
      const input = updateRoadmapItemSchema.parse(patch);
      const items = readRawRoadmapFile();
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) throw notFound("Roadmap item not found");
      const current = items[index]!;
      const next: RoadmapItem = {
        ...current,
        ...input,
        updatedAt: new Date().toISOString(),
      };
      items[index] = next;
      writeRawRoadmapFile(items);
      return next;
    },

    remove(id: string): { ok: true } {
      const items = readRawRoadmapFile();
      const nextItems = items.filter((item) => item.id !== id);
      if (nextItems.length === items.length) throw notFound("Roadmap item not found");
      writeRawRoadmapFile(nextItems);
      return { ok: true };
    },
  };
}
