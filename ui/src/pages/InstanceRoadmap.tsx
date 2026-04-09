import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateRoadmapItem,
  RoadmapItem,
  RoadmapItemLane,
  RoadmapItemStatus,
  UpdateRoadmapItem,
} from "@paperclipai/shared";
import { CalendarClock, Flag, Plus, Trash2 } from "lucide-react";
import { roadmapApi } from "@/api/roadmap";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const LANE_ORDER: RoadmapItemLane[] = ["current", "next", "later"];

const LANE_COPY: Record<RoadmapItemLane, { title: string; description: string }> = {
  current: {
    title: "Current",
    description: "The active product slice we are driving right now.",
  },
  next: {
    title: "Next",
    description: "Queued work that should unlock the next jump in usefulness.",
  },
  later: {
    title: "Later",
    description: "Important expansion ideas that should wait until the base product is solid.",
  },
};

const STATUS_LABELS: Record<RoadmapItemStatus, string> = {
  idea: "Idea",
  planned: "Planned",
  in_progress: "In Progress",
  blocked: "Blocked",
  completed: "Completed",
};

const STATUS_CLASSES: Record<RoadmapItemStatus, string> = {
  idea: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  planned: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  in_progress: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  blocked: "border-red-500/30 bg-red-500/10 text-red-300",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
};

function toLocalDateTimeInput(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalDateTimeInput(value: string) {
  if (!value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatRoadmapDate(value: string | null) {
  if (!value) return "No target date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function sortItems(items: RoadmapItem[]) {
  return [...items].sort((left, right) => {
    const leftTime = left.targetAt ? new Date(left.targetAt).getTime() : Number.POSITIVE_INFINITY;
    const rightTime = right.targetAt ? new Date(right.targetAt).getTime() : Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

export function InstanceRoadmap() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CreateRoadmapItem>({
    title: "",
    description: null,
    lane: "current",
    status: "planned",
    owner: null,
    targetAt: null,
    tags: [],
  });
  const [draftTargetAt, setDraftTargetAt] = useState("");
  const [draftTags, setDraftTags] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings", href: "/instance/settings/general" },
      { label: "Roadmap" },
    ]);
  }, [setBreadcrumbs]);

  const roadmapQuery = useQuery({
    queryKey: queryKeys.instance.roadmap,
    queryFn: () => roadmapApi.list(),
  });

  const createItem = useMutation({
    mutationFn: (input: CreateRoadmapItem) => roadmapApi.create(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.roadmap });
      setDraft({
        title: "",
        description: null,
        lane: "current",
        status: "planned",
        owner: null,
        targetAt: null,
        tags: [],
      });
      setDraftTargetAt("");
      setDraftTags("");
      pushToast({ title: "Roadmap item added", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Roadmap item failed",
        body: error instanceof Error ? error.message : "Unable to add roadmap item.",
        tone: "error",
      });
    },
  });

  const updateItem = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateRoadmapItem }) => roadmapApi.update(id, patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.roadmap });
    },
    onError: (error) => {
      pushToast({
        title: "Roadmap update failed",
        body: error instanceof Error ? error.message : "Unable to update roadmap item.",
        tone: "error",
      });
    },
  });

  const deleteItem = useMutation({
    mutationFn: (id: string) => roadmapApi.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.roadmap });
      pushToast({ title: "Roadmap item removed", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Roadmap delete failed",
        body: error instanceof Error ? error.message : "Unable to remove roadmap item.",
        tone: "error",
      });
    },
  });

  const grouped = useMemo(() => {
    const items = sortItems(roadmapQuery.data?.data ?? []);
    return LANE_ORDER.map((lane) => ({
      lane,
      items: items.filter((item) => item.lane === lane),
    }));
  }, [roadmapQuery.data?.data]);

  function submitDraft() {
    if (!draft.title.trim()) return;
    createItem.mutate({
      ...draft,
      title: draft.title.trim(),
      description: draft.description?.trim() || null,
      owner: draft.owner?.trim() || null,
      targetAt: fromLocalDateTimeInput(draftTargetAt),
      tags: draftTags
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    });
  }

  if (roadmapQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading roadmap...</div>;
  }

  if (roadmapQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {roadmapQuery.error instanceof Error ? roadmapQuery.error.message : "Failed to load roadmap."}
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-8">
      <section className="rounded-2xl border border-border/70 bg-card/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Flag className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-lg font-semibold">Product Roadmap</h1>
            </div>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              A working timeline for how we evolve Paperclip from today’s linked-runtime control plane into a mobile-first, chat-capable, artifact-rich operating system for agents.
            </p>
          </div>
          <div className="rounded-xl border border-border/70 bg-background/40 px-4 py-3 text-sm text-muted-foreground">
            <div className="font-medium text-foreground">{(roadmapQuery.data?.data ?? []).length} roadmap items</div>
            <div className="mt-1">Add ideas here as they become concrete enough to schedule.</div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-card/50 p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Plus className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Add Roadmap Item</h2>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Title</span>
            <Input
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="Ship mobile supervision MVP"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Owner</span>
            <Input
              value={draft.owner ?? ""}
              onChange={(event) => setDraft((current) => ({ ...current, owner: event.target.value || null }))}
              placeholder="product"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Lane</span>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={draft.lane}
              onChange={(event) => setDraft((current) => ({ ...current, lane: event.target.value as RoadmapItemLane }))}
            >
              {LANE_ORDER.map((lane) => (
                <option key={lane} value={lane}>{LANE_COPY[lane].title}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Status</span>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={draft.status}
              onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as RoadmapItemStatus }))}
            >
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Target date & time</span>
            <Input
              type="datetime-local"
              value={draftTargetAt}
              onChange={(event) => setDraftTargetAt(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Tags</span>
            <Input
              value={draftTags}
              onChange={(event) => setDraftTags(event.target.value)}
              placeholder="mobile, chat, connectors"
            />
          </label>
          <label className="space-y-1 md:col-span-2">
            <span className="text-xs text-muted-foreground">Description</span>
            <Textarea
              value={draft.description ?? ""}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value || null }))}
              className="min-h-[108px]"
              placeholder="What does done actually mean here?"
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            onClick={submitDraft}
            disabled={!draft.title.trim() || createItem.isPending}
          >
            {createItem.isPending ? "Adding..." : "Add item"}
          </Button>
        </div>
      </section>

      <div className="space-y-8">
        {grouped.map(({ lane, items }) => (
          <section key={lane} className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold">{LANE_COPY[lane].title}</h2>
              <p className="text-sm text-muted-foreground">{LANE_COPY[lane].description}</p>
            </div>

            {items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-4 py-6 text-sm text-muted-foreground">
                No roadmap items in this lane yet.
              </div>
            ) : (
              <div className="space-y-4">
                {items.map((item) => (
                  <div key={item.id} className="relative pl-6">
                    <div className="absolute left-2 top-2 h-full w-px bg-border/70" />
                    <div className="absolute left-0 top-2 h-4 w-4 rounded-full border border-border/70 bg-background shadow-sm" />
                    <div className="rounded-2xl border border-border/70 bg-card/60 p-4 shadow-[0_1px_0_rgba(255,255,255,0.02)]">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold">{item.title}</h3>
                            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_CLASSES[item.status])}>
                              {STATUS_LABELS[item.status]}
                            </span>
                            <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                              {item.source === "seed" ? "Seeded" : "Manual"}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <CalendarClock className="h-3.5 w-3.5" />
                              {formatRoadmapDate(item.targetAt)}
                            </span>
                            {item.owner ? <span>Owner: {item.owner}</span> : null}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground"
                          onClick={() => deleteItem.mutate(item.id)}
                          disabled={deleteItem.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>

                      {item.description ? (
                        <p className="mt-3 text-sm leading-6 text-muted-foreground">{item.description}</p>
                      ) : null}

                      {item.tags.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {item.tags.map((tag) => (
                            <span key={tag} className="rounded-full bg-accent/70 px-2 py-1 text-[11px] text-muted-foreground">
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      <div className="mt-4 grid gap-3 md:grid-cols-[180px_220px]">
                        <label className="space-y-1">
                          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Status</span>
                          <select
                            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            value={item.status}
                            onChange={(event) =>
                              updateItem.mutate({
                                id: item.id,
                                patch: { status: event.target.value as RoadmapItemStatus },
                              })
                            }
                          >
                            {Object.entries(STATUS_LABELS).map(([value, label]) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="space-y-1">
                          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Target</span>
                          <Input
                            type="datetime-local"
                            defaultValue={toLocalDateTimeInput(item.targetAt)}
                            onBlur={(event) =>
                              updateItem.mutate({
                                id: item.id,
                                patch: { targetAt: fromLocalDateTimeInput(event.target.value) },
                              })
                            }
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
