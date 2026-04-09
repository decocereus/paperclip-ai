#!/usr/bin/env node

import { createHmac } from "node:crypto";

const JWT_ALGORITHM = "HS256";
const DEFAULT_TTL_SECONDS = 60 * 60 * 48;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signPayload(secret, signingInput) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

export function looksLikeJwt(token) {
  if (!token) return false;
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function resolveAdapterType(env) {
  return (
    nonEmpty(env.PAPERCLIP_AGENT_ADAPTER_TYPE) ??
    nonEmpty(env.PAPERCLIP_ADAPTER_TYPE) ??
    nonEmpty(env.PAPERCLIP_AGENT_ADAPTER) ??
    "codex_local"
  );
}

export function createLocalAgentJwtFromEnv(env = process.env) {
  const secret = nonEmpty(env.PAPERCLIP_AGENT_JWT_SECRET);
  const agentId = nonEmpty(env.PAPERCLIP_AGENT_ID);
  const companyId = nonEmpty(env.PAPERCLIP_COMPANY_ID);
  const runId = nonEmpty(env.PAPERCLIP_RUN_ID);
  if (!secret || !agentId || !companyId || !runId) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: resolveAdapterType(env),
    run_id: runId,
    iat: now,
    exp: now + parsePositiveInt(env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, DEFAULT_TTL_SECONDS),
    iss: env.PAPERCLIP_AGENT_JWT_ISSUER ?? "paperclip",
    aud: env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? "paperclip-api",
  };
  const header = {
    alg: JWT_ALGORITHM,
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(secret, signingInput);
  return `${signingInput}.${signature}`;
}

export function resolveBridgeApiKey(env = process.env) {
  const configuredToken = nonEmpty(env.PAPERCLIP_API_KEY);
  if (configuredToken && looksLikeJwt(configuredToken)) {
    return configuredToken;
  }

  const localAgentJwt = createLocalAgentJwtFromEnv(env);
  if (localAgentJwt) return localAgentJwt;
  return configuredToken;
}
