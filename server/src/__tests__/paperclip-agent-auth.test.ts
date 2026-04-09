import { describe, expect, it } from "vitest";
import { createLocalAgentJwtFromEnv, looksLikeJwt, resolveBridgeApiKey } from "../../../scripts/paperclip-agent-auth.mjs";

function decodeJwtPayload(token: string) {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) throw new Error("JWT payload missing");
  const raw = Buffer.from(payloadPart, "base64url").toString("utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("paperclip agent auth helpers", () => {
  it("keeps configured JWT keys unchanged", () => {
    const env = {
      PAPERCLIP_API_KEY: "header.payload.signature",
      PAPERCLIP_AGENT_JWT_SECRET: "unused",
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_RUN_ID: "run-1",
    };

    expect(resolveBridgeApiKey(env)).toBe("header.payload.signature");
  });

  it("synthesizes a local agent JWT when api key is not jwt-shaped", () => {
    const env = {
      PAPERCLIP_API_KEY: "pcp_stale_key",
      PAPERCLIP_AGENT_JWT_SECRET: "test-secret",
      PAPERCLIP_AGENT_ID: "agent-123",
      PAPERCLIP_COMPANY_ID: "company-456",
      PAPERCLIP_RUN_ID: "run-789",
      PAPERCLIP_AGENT_JWT_TTL_SECONDS: "600",
      PAPERCLIP_AGENT_JWT_ISSUER: "paperclip-test",
      PAPERCLIP_AGENT_JWT_AUDIENCE: "paperclip-api-test",
      PAPERCLIP_AGENT_ADAPTER_TYPE: "codex_local",
    };

    const token = resolveBridgeApiKey(env);
    expect(typeof token).toBe("string");
    expect(looksLikeJwt(token!)).toBe(true);

    const payload = decodeJwtPayload(token!);
    expect(payload.sub).toBe("agent-123");
    expect(payload.company_id).toBe("company-456");
    expect(payload.adapter_type).toBe("codex_local");
    expect(payload.run_id).toBe("run-789");
    expect(payload.iss).toBe("paperclip-test");
    expect(payload.aud).toBe("paperclip-api-test");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect((payload.exp as number) - (payload.iat as number)).toBe(600);
  });

  it("returns null when neither configured key nor local jwt inputs are available", () => {
    const env = {
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_RUN_ID: "run-1",
    };

    expect(resolveBridgeApiKey(env)).toBeNull();
  });

  it("falls back to configured key when local jwt inputs are incomplete", () => {
    const env = {
      PAPERCLIP_API_KEY: "pcp_board_key",
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_RUN_ID: "run-1",
    };

    expect(resolveBridgeApiKey(env)).toBe("pcp_board_key");
  });

  it("can generate a local jwt directly from environment inputs", () => {
    const token = createLocalAgentJwtFromEnv({
      PAPERCLIP_AGENT_JWT_SECRET: "test-secret",
      PAPERCLIP_AGENT_ID: "agent-abc",
      PAPERCLIP_COMPANY_ID: "company-def",
      PAPERCLIP_RUN_ID: "run-ghi",
      PAPERCLIP_ADAPTER_TYPE: "claude_local",
    });

    expect(token).not.toBeNull();
    expect(looksLikeJwt(token!)).toBe(true);

    const payload = decodeJwtPayload(token!);
    expect(payload.sub).toBe("agent-abc");
    expect(payload.company_id).toBe("company-def");
    expect(payload.adapter_type).toBe("claude_local");
    expect(payload.run_id).toBe("run-ghi");
  });
});
