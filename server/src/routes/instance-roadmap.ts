import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRoadmapItemSchema, updateRoadmapItemSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { instanceRoadmapService, instanceSettingsService, logActivity } from "../services/index.js";
import { getActorInfo } from "./authz.js";

function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function instanceRoadmapRoutes(db: Db) {
  const router = Router();
  const roadmap = instanceRoadmapService();
  const instanceSettings = instanceSettingsService(db);

  router.get("/instance/roadmap", async (req, res) => {
    assertBoard(req);
    res.json({ data: roadmap.list() });
  });

  router.post("/instance/roadmap", validate(createRoadmapItemSchema), async (req, res) => {
    assertBoard(req);
    const item = roadmap.create(req.body);
    const actor = getActorInfo(req);
    const companyIds = await instanceSettings.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "instance.roadmap.created",
          entityType: "instance_roadmap",
          entityId: item.id,
          details: {
            title: item.title,
            lane: item.lane,
            status: item.status,
            targetAt: item.targetAt,
          },
        }),
      ),
    );
    res.status(201).json(item);
  });

  router.patch("/instance/roadmap/:id", validate(updateRoadmapItemSchema), async (req, res) => {
    assertBoard(req);
    const id = String(req.params.id);
    const item = roadmap.update(id, req.body);
    const actor = getActorInfo(req);
    const companyIds = await instanceSettings.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "instance.roadmap.updated",
          entityType: "instance_roadmap",
          entityId: item.id,
          details: {
            changedKeys: Object.keys(req.body).sort(),
            status: item.status,
            lane: item.lane,
            targetAt: item.targetAt,
          },
        }),
      ),
    );
    res.json(item);
  });

  router.delete("/instance/roadmap/:id", async (req, res) => {
    assertBoard(req);
    const id = String(req.params.id);
    const actor = getActorInfo(req);
    const result = roadmap.remove(id);
    const companyIds = await instanceSettings.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "instance.roadmap.removed",
          entityType: "instance_roadmap",
          entityId: id,
          details: null,
        }),
      ),
    );
    res.json(result);
  });

  return router;
}
