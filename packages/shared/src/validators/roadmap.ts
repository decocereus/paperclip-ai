import { z } from "zod";

export const roadmapItemStatusSchema = z.enum([
  "idea",
  "planned",
  "in_progress",
  "blocked",
  "completed",
]);

export const roadmapItemLaneSchema = z.enum(["current", "next", "later"]);

export const roadmapItemSourceSchema = z.enum(["seed", "manual"]);

export const roadmapItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullable(),
  lane: roadmapItemLaneSchema,
  status: roadmapItemStatusSchema,
  owner: z.string().trim().max(120).nullable(),
  targetAt: z.string().datetime().nullable(),
  source: roadmapItemSourceSchema,
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createRoadmapItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullable().optional(),
  lane: roadmapItemLaneSchema.default("current"),
  status: roadmapItemStatusSchema.default("planned"),
  owner: z.string().trim().max(120).nullable().optional(),
  targetAt: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

export const updateRoadmapItemSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  lane: roadmapItemLaneSchema.optional(),
  status: roadmapItemStatusSchema.optional(),
  owner: z.string().trim().max(120).nullable().optional(),
  targetAt: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one roadmap field must be provided.",
});

export type RoadmapItemStatus = z.infer<typeof roadmapItemStatusSchema>;
export type RoadmapItemLane = z.infer<typeof roadmapItemLaneSchema>;
export type RoadmapItemSource = z.infer<typeof roadmapItemSourceSchema>;
export type CreateRoadmapItem = z.infer<typeof createRoadmapItemSchema>;
export type UpdateRoadmapItem = z.infer<typeof updateRoadmapItemSchema>;
