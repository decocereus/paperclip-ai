export type RoadmapItemStatus =
  | "idea"
  | "planned"
  | "in_progress"
  | "blocked"
  | "completed";

export type RoadmapItemLane = "current" | "next" | "later";

export type RoadmapItemSource = "seed" | "manual";

export interface RoadmapItem {
  id: string;
  title: string;
  description: string | null;
  lane: RoadmapItemLane;
  status: RoadmapItemStatus;
  owner: string | null;
  targetAt: string | null;
  source: RoadmapItemSource;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}
