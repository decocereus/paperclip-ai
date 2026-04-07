import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuntimeSourcesConfig } from "@paperclipai/shared";
import type { RuntimeSourceDiscovery } from "@paperclipai/shared/runtime-sources";
import { Link2, RefreshCw } from "lucide-react";
import { runtimeSourcesApi } from "@/api/runtimeSources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";

type SourceKey = "paperclip" | "codex" | "openclaw";

function sourceLabel(key: SourceKey): string {
  if (key === "paperclip") return "Paperclip";
  if (key === "codex") return "Codex";
  return "OpenClaw";
}

function discoverySummary(entry: RuntimeSourceDiscovery): string {
  if (entry.kind === "paperclip") {
    return `${entry.inventory.paperclipInstanceCount ?? 0} instance(s)`;
  }
  if (entry.kind === "codex") {
    return `${entry.inventory.codexThreadCount ?? "unknown"} threads, ${entry.inventory.codexSkillCount ?? "unknown"} skills, ${entry.inventory.codexPluginCount ?? "unknown"} plugins`;
  }
  return `${entry.inventory.openclawSessionCount ?? "unknown"} sessions, ${entry.inventory.openclawSkillCount ?? "unknown"} skills, memory ${entry.inventory.openclawMemoryDbPresent ? "present" : "missing"}`;
}

function buildDraftFromDiscovery(discovery: RuntimeSourceDiscovery[]): RuntimeSourcesConfig {
  const next: RuntimeSourcesConfig = {};
  for (const entry of discovery) {
    if (entry.status !== "available") continue;
    if (entry.kind === "paperclip") {
      next.paperclip = {
        enabled: true,
        mode: "linked",
        homeDir: entry.homeDir,
        instanceId: entry.inventory.paperclipCurrentInstanceId ?? "default",
      };
      continue;
    }
    if (entry.kind === "codex") {
      next.codex = {
        enabled: true,
        mode: "linked",
        homeDir: entry.homeDir,
      };
      continue;
    }
    next.openclaw = {
      enabled: true,
      mode: "linked",
      homeDir: entry.homeDir,
    };
  }
  return next;
}

export function InstanceRuntimeSourcesSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuntimeSourcesConfig | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Runtime Sources" },
    ]);
  }, [setBreadcrumbs]);

  const runtimeSourcesQuery = useQuery({
    queryKey: queryKeys.instance.runtimeSources,
    queryFn: () => runtimeSourcesApi.get(),
  });

  const discoveryQuery = useQuery({
    queryKey: queryKeys.instance.runtimeSourcesDiscovery,
    queryFn: () => runtimeSourcesApi.discover(),
  });
  const codexThreadsQuery = useQuery({
    queryKey: queryKeys.instance.runtimeSourcesCodexThreads,
    queryFn: () => runtimeSourcesApi.codexThreads(5),
  });
  const codexSkillsQuery = useQuery({
    queryKey: queryKeys.instance.runtimeSourcesCodexSkills,
    queryFn: () => runtimeSourcesApi.codexSkills(10),
  });
  const codexPluginsQuery = useQuery({
    queryKey: queryKeys.instance.runtimeSourcesCodexPlugins,
    queryFn: () => runtimeSourcesApi.codexPlugins(10),
  });
  const openclawSessionsQuery = useQuery({
    queryKey: queryKeys.instance.runtimeSourcesOpenClawSessions,
    queryFn: () => runtimeSourcesApi.openclawSessions(5),
  });
  const openclawSkillsQuery = useQuery({
    queryKey: queryKeys.instance.runtimeSourcesOpenClawSkills,
    queryFn: () => runtimeSourcesApi.openclawSkills(10),
  });

  useEffect(() => {
    if (runtimeSourcesQuery.data) {
      setDraft(runtimeSourcesQuery.data);
      return;
    }
    if (discoveryQuery.data?.data) {
      setDraft(buildDraftFromDiscovery(discoveryQuery.data.data));
    }
  }, [runtimeSourcesQuery.data, discoveryQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (next: RuntimeSourcesConfig) => runtimeSourcesApi.update(next),
    onSuccess: async () => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.runtimeSources }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update runtime sources.");
    },
  });

  const discoveredByKind = useMemo(() => {
    const map = new Map<SourceKey, RuntimeSourceDiscovery>();
    for (const entry of discoveryQuery.data?.data ?? []) {
      if (entry.kind === "paperclip" || entry.kind === "codex" || entry.kind === "openclaw") {
        map.set(entry.kind, entry);
      }
    }
    return map;
  }, [discoveryQuery.data]);

  if (runtimeSourcesQuery.isLoading || discoveryQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading runtime sources...</div>;
  }

  if (runtimeSourcesQuery.error || discoveryQuery.error) {
    const error = runtimeSourcesQuery.error ?? discoveryQuery.error;
    return (
      <div className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load runtime sources."}
      </div>
    );
  }

  const effectiveDraft = draft ?? {};

  function updateDraft<K extends SourceKey>(
    key: K,
    patch: Partial<NonNullable<RuntimeSourcesConfig[K]>>,
  ) {
    setDraft((prev) => {
      const next = { ...(prev ?? {}) } as RuntimeSourcesConfig;
      const existing = next[key];
      if (!existing) return prev;
      next[key] = { ...existing, ...patch } as NonNullable<RuntimeSourcesConfig[K]>;
      return next;
    });
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Link2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Runtime Sources</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Link this Paperclip instance to local Paperclip, Codex, and OpenClaw homes on this machine. Linked mode keeps the native runtime homes canonical so sessions, skills, plugins, and memory remain visible in their original tools.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.instance.runtimeSourcesDiscovery })}
          disabled={discoveryQuery.isFetching}
        >
          <RefreshCw className={discoveryQuery.isFetching ? "animate-spin" : ""} />
          {discoveryQuery.isFetching ? "Refreshing..." : "Refresh Discovery"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setDraft(buildDraftFromDiscovery(discoveryQuery.data?.data ?? []))}
        >
          Use Detected Homes
        </Button>
        <Button
          onClick={() => saveMutation.mutate(effectiveDraft)}
          disabled={saveMutation.isPending || Object.keys(effectiveDraft).length === 0}
        >
          {saveMutation.isPending ? "Saving..." : "Save Runtime Sources"}
        </Button>
      </div>

        {(["paperclip", "codex", "openclaw"] as SourceKey[]).map((key) => {
        const config = effectiveDraft[key];
        const discovered = discoveredByKind.get(key) ?? null;

        return (
          <section key={key} className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-sm font-semibold">{sourceLabel(key)}</h2>
                <span className="text-xs text-muted-foreground">
                  {discovered ? `${discovered.status} • ${discoverySummary(discovered)}` : "not detected"}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                {key === "paperclip"
                  ? "Link the local Paperclip home and default instance you want this checkout to supervise."
                  : key === "codex"
                    ? "Link the Codex home that contains your existing threads, skills, and plugins."
                    : "Link the OpenClaw home that contains your existing sessions, skills, and memory."}
              </p>
            </div>

            {config ? (
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Mode</span>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={config.mode}
                    onChange={(event) =>
                      updateDraft(key, { mode: event.target.value as "linked" | "managed" })
                    }
                  >
                    <option value="linked">linked</option>
                    <option value="managed">managed</option>
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Home directory</span>
                  <Input
                    value={config.homeDir}
                    onChange={(event) => updateDraft(key, { homeDir: event.target.value })}
                  />
                </label>
                {key === "paperclip" && "instanceId" in config ? (
                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="text-muted-foreground">Instance ID</span>
                    <Input
                      value={config.instanceId ?? ""}
                      onChange={(event) => updateDraft("paperclip", { instanceId: event.target.value })}
                    />
                  </label>
                ) : null}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                No linked source configured yet for {sourceLabel(key)}.
              </div>
            )}

            {key === "codex" && (codexThreadsQuery.data?.data?.length ?? 0) > 0 ? (
              <div className="rounded-lg border border-border/70 bg-accent/10 px-3 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent Codex Threads</p>
                <div className="mt-2 space-y-2">
                  {(codexThreadsQuery.data?.data ?? []).map((thread) => (
                    <div key={thread.id} className="text-sm">
                      <div className="font-medium">{thread.threadName ?? thread.id}</div>
                      <div className="font-mono text-xs text-muted-foreground">{thread.id}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {key === "codex" && (((codexSkillsQuery.data?.data?.length ?? 0) > 0) || ((codexPluginsQuery.data?.data?.length ?? 0) > 0)) ? (
              <div className="grid gap-3 md:grid-cols-2">
                {(codexSkillsQuery.data?.data?.length ?? 0) > 0 ? (
                  <div className="rounded-lg border border-border/70 bg-accent/10 px-3 py-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Codex Skills</p>
                    <div className="mt-2 space-y-1">
                      {(codexSkillsQuery.data?.data ?? []).map((entry) => (
                        <div key={entry.name} className="text-sm">
                          <div className="font-medium">{entry.name}</div>
                          <div className="font-mono text-xs text-muted-foreground break-all">{entry.path}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {(codexPluginsQuery.data?.data?.length ?? 0) > 0 ? (
                  <div className="rounded-lg border border-border/70 bg-accent/10 px-3 py-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Codex Plugins</p>
                    <div className="mt-2 space-y-1">
                      {(codexPluginsQuery.data?.data ?? []).map((entry) => (
                        <div key={entry.name} className="text-sm">
                          <div className="font-medium">{entry.name}</div>
                          <div className="font-mono text-xs text-muted-foreground break-all">{entry.path}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {key === "openclaw" && (openclawSessionsQuery.data?.data?.length ?? 0) > 0 ? (
              <div className="rounded-lg border border-border/70 bg-accent/10 px-3 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent OpenClaw Sessions</p>
                <div className="mt-2 space-y-2">
                  {(openclawSessionsQuery.data?.data ?? []).map((session) => (
                    <div key={session.sessionKey} className="text-sm">
                      <div className="font-medium">{session.originLabel ?? session.sessionKey}</div>
                      <div className="font-mono text-xs text-muted-foreground">{session.sessionId ?? session.sessionKey}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {key === "openclaw" && (openclawSkillsQuery.data?.data?.length ?? 0) > 0 ? (
              <div className="rounded-lg border border-border/70 bg-accent/10 px-3 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">OpenClaw Skills</p>
                <div className="mt-2 space-y-1">
                  {(openclawSkillsQuery.data?.data ?? []).map((entry) => (
                    <div key={entry.name} className="text-sm">
                      <div className="font-medium">{entry.name}</div>
                      <div className="font-mono text-xs text-muted-foreground break-all">{entry.path}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
