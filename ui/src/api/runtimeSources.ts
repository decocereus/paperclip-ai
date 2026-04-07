import type { RuntimeSourcesConfig } from "@paperclipai/shared";
import type {
  CodexThreadSummary,
  OpenClawSessionSummary,
  RuntimeNamedEntry,
  RuntimeSourceDiscovery,
} from "@paperclipai/shared/runtime-sources";
import { api } from "./client";

export const runtimeSourcesApi = {
  get: () => api.get<RuntimeSourcesConfig | null>("/instance/runtime-sources"),
  update: (runtimeSources: RuntimeSourcesConfig) =>
    api.patch<RuntimeSourcesConfig | null>("/instance/runtime-sources", runtimeSources),
  discover: () =>
    api.get<{ data: RuntimeSourceDiscovery[] }>("/instance/runtime-sources/discovery"),
  pickDirectory: (prompt?: string) =>
    api.post<{ path: string | null; canceled: boolean }>("/instance/runtime-sources/pick-directory", {
      ...(prompt ? { prompt } : {}),
    }),
  codexThreads: (limit = 20, cwd?: string | null) =>
    api.get<{ data: CodexThreadSummary[] }>(
      `/instance/runtime-sources/codex/threads?limit=${encodeURIComponent(String(limit))}${
        cwd && cwd.trim().length > 0 ? `&cwd=${encodeURIComponent(cwd.trim())}` : ""
      }`,
    ),
  codexSkills: (limit = 50) =>
    api.get<{ data: RuntimeNamedEntry[] }>(`/instance/runtime-sources/codex/skills?limit=${encodeURIComponent(String(limit))}`),
  codexPlugins: (limit = 50) =>
    api.get<{ data: RuntimeNamedEntry[] }>(`/instance/runtime-sources/codex/plugins?limit=${encodeURIComponent(String(limit))}`),
  openclawSessions: (limit = 20) =>
    api.get<{ data: OpenClawSessionSummary[] }>(`/instance/runtime-sources/openclaw/sessions?limit=${encodeURIComponent(String(limit))}`),
  openclawSkills: (limit = 50) =>
    api.get<{ data: RuntimeNamedEntry[] }>(`/instance/runtime-sources/openclaw/skills?limit=${encodeURIComponent(String(limit))}`),
  openclawGatewayToken: () =>
    api.get<{ token: string | null }>("/instance/runtime-sources/openclaw/gateway-token"),
};
