import type { CreateRoadmapItem, RoadmapItem, UpdateRoadmapItem } from "@paperclipai/shared";
import { api } from "./client";

export const roadmapApi = {
  list: () => api.get<{ data: RoadmapItem[] }>("/instance/roadmap"),
  create: (input: CreateRoadmapItem) => api.post<RoadmapItem>("/instance/roadmap", input),
  update: (id: string, patch: UpdateRoadmapItem) => api.patch<RoadmapItem>(`/instance/roadmap/${id}`, patch),
  remove: (id: string) => api.delete<{ ok: true }>(`/instance/roadmap/${id}`),
};
