import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { instanceRoadmapRoutes } from "../routes/instance-roadmap.js";

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  };
});

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceRoadmapRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("instance roadmap routes", () => {
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  let tempHome = "";

  beforeEach(() => {
    vi.clearAllMocks();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-roadmap-"));
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
  });

  it("returns seeded roadmap items on first read", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/instance/roadmap");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        title: expect.any(String),
        status: expect.any(String),
        lane: expect.any(String),
      }),
    );
  });

  it("creates and updates roadmap items", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const created = await request(app)
      .post("/api/instance/roadmap")
      .send({
        title: "Add manager-agent connectors",
        description: "Email and calendar first.",
        lane: "next",
        status: "planned",
        targetAt: "2026-05-02T12:00:00.000Z",
        tags: ["manager", "connectors"],
      });

    expect(created.status).toBe(201);
    expect(created.body).toEqual(
      expect.objectContaining({
        title: "Add manager-agent connectors",
        lane: "next",
        status: "planned",
      }),
    );

    const updated = await request(app)
      .patch(`/api/instance/roadmap/${created.body.id}`)
      .send({
        status: "in_progress",
      });

    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe("in_progress");
    expect(mockLogActivity).toHaveBeenCalled();
  });
});
