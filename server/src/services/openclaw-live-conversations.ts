import fs from "node:fs";
import path from "node:path";
import crypto, { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import type {
  IssueConversationItem,
  IssueConversationSnapshot,
  IssueRuntimeLink,
} from "@paperclipai/shared";
import {
  mapOpenClawSessionMessages,
  normalizeOpenClawMessageText,
  readOpenClawConversationSnapshotFromHome,
  resolveOpenClawSessionSummary,
} from "./runtime-conversations.js";

type Json = Record<string, unknown>;

type GatewayRequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
};

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  expectFinal: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

type GatewayClientRequestOptions = {
  timeoutMs: number;
  expectFinal?: boolean;
};

type GatewayDeviceIdentity = {
  deviceId: string;
  publicKeyRawBase64Url: string;
  privateKeyPem: string;
  source: "configured" | "linked_home" | "ephemeral";
};

type GatewayResponseError = Error & {
  gatewayCode?: string;
  gatewayDetails?: Record<string, unknown>;
};

const PROTOCOL_VERSION = 3;
const DEFAULT_SCOPES = ["operator.admin", "operator.read", "operator.write"];
const DEFAULT_CLIENT_ID = "gateway-client";
const DEFAULT_CLIENT_MODE = "backend";
const DEFAULT_CLIENT_VERSION = "paperclip";
const DEFAULT_ROLE = "operator";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

function parseOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return Math.max(1, Math.floor(parsed));
  }
  return null;
}

function mapOpenClawContentText(content: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const item of content) {
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "text" && typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text.trim());
      continue;
    }
    if (type === "toolCall" && typeof item.name === "string") {
      parts.push(`[tool:${item.name}]`);
      continue;
    }
  }
  return parts.join("\n\n").trim();
}

function asIsoTimestamp(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

function mapSessionMessagePayloadToItem(payload: Record<string, unknown>): IssueConversationItem | null {
  const message = asRecord(payload.message);
  if (!message) return null;
  const roleRaw = typeof message.role === "string" ? message.role : "system";
  const contentArray = Array.isArray(message.content)
    ? message.content.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
  const text = normalizeOpenClawMessageText(roleRaw, mapOpenClawContentText(contentArray));
  if (!text) return null;
  const role: IssueConversationItem["role"] =
    roleRaw === "user"
      ? "user"
      : roleRaw === "assistant"
        ? "assistant"
        : roleRaw === "toolResult"
          ? "tool"
          : "system";

  return {
    id:
      nonEmpty(payload.messageId) ??
      nonEmpty(payload.id) ??
      nonEmpty(payload.entryId) ??
      `${role}:${text.slice(0, 24)}`,
    role,
    text,
    createdAt: asIsoTimestamp(message.timestamp ?? payload.timestamp ?? payload.ts),
    source: "openclaw",
    rawType: roleRaw,
  };
}

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    const parsed = value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
    return parsed.length > 0 ? Array.from(new Set(parsed)) : [...DEFAULT_SCOPES];
  }
  if (typeof value === "string") {
    const parsed = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    return parsed.length > 0 ? Array.from(new Set(parsed)) : [...DEFAULT_SCOPES];
  }
  return [...DEFAULT_SCOPES];
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function headerMapGetIgnoreCase(headers: Record<string, string>, key: string): string | null {
  const match = Object.entries(headers).find(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase());
  return match ? match[1] : null;
}

function headerMapHasIgnoreCase(headers: Record<string, string>, key: string): boolean {
  return Object.keys(headers).some((entryKey) => entryKey.toLowerCase() === key.toLowerCase());
}

function tokenFromAuthHeader(rawHeader: string | null): string | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^bearer\s+(.+)$/i);
  return match ? nonEmpty(match[1]) : trimmed;
}

function resolveAuthToken(config: Record<string, unknown>, headers: Record<string, string>): string | null {
  const explicit = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  if (explicit) return explicit;

  const tokenHeader = headerMapGetIgnoreCase(headers, "x-openclaw-token");
  if (nonEmpty(tokenHeader)) return nonEmpty(tokenHeader);

  const authHeader =
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    headerMapGetIgnoreCase(headers, "authorization");
  return tokenFromAuthHeader(authHeader);
}

function toAuthorizationHeaderValue(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (!trimmed) return trimmed;
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), "utf8"))),
    ).toString("utf8");
  }
  return String(data ?? "");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const platform = params.platform?.trim() ?? "";
  const deviceFamily = params.deviceFamily?.trim() ?? "";
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

function resolveDeviceIdentity(config: Record<string, unknown>): GatewayDeviceIdentity {
  const linkedHome = nonEmpty(config.openclawHomeDir);
  if (linkedHome) {
    const linked = resolveLinkedHomeDeviceIdentity(linkedHome);
    if (linked) return linked;
  }
  const configuredPrivateKey = nonEmpty(config.devicePrivateKeyPem);
  if (configuredPrivateKey) {
    const privateKey = crypto.createPrivateKey(configuredPrivateKey);
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const raw = derivePublicKeyRaw(publicKeyPem);
    return {
      deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
      publicKeyRawBase64Url: base64UrlEncode(raw),
      privateKeyPem: configuredPrivateKey,
      source: "configured",
    };
  }

  const generated = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = generated.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const raw = derivePublicKeyRaw(publicKeyPem);
  return {
    deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKeyRawBase64Url: base64UrlEncode(raw),
    privateKeyPem,
    source: "ephemeral",
  };
}

function resolveLinkedHomeDeviceIdentity(openclawHome: string): GatewayDeviceIdentity | null {
  const identityPath = path.join(openclawHome, "identity", "device.json");
  try {
    const raw = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<string, unknown>;
    const privateKeyPem = nonEmpty(raw.privateKeyPem);
    if (!privateKeyPem) return null;
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const publicKeyRaw = derivePublicKeyRaw(publicKeyPem);
    return {
      deviceId:
        nonEmpty(raw.deviceId) ??
        crypto.createHash("sha256").update(publicKeyRaw).digest("hex"),
      publicKeyRawBase64Url: base64UrlEncode(publicKeyRaw),
      privateKeyPem,
      source: "linked_home",
    };
  } catch {
    return null;
  }
}

function isEventFrame(value: unknown): value is GatewayEventFrame {
  const record = asRecord(value);
  return Boolean(record && record.type === "event" && typeof record.event === "string");
}

function isResponseFrame(value: unknown): value is GatewayResponseFrame {
  const record = asRecord(value);
  return Boolean(record && record.type === "res" && typeof record.id === "string" && typeof record.ok === "boolean");
}

function normalizeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

class GatewayWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private challengePromise!: Promise<string>;
  private resolveChallenge!: (nonce: string) => void;
  private rejectChallenge!: (err: Error) => void;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly onEvent: (frame: GatewayEventFrame) => Promise<void> | void,
  ) {
    this.resetChallenge();
  }

  private resetChallenge() {
    this.challengePromise = new Promise<string>((resolve, reject) => {
      this.resolveChallenge = resolve;
      this.rejectChallenge = reject;
    });
  }

  async connect(
    buildConnectParams: (nonce: string) => Record<string, unknown>,
    timeoutMs: number,
  ) {
    this.resetChallenge();
    this.ws = new WebSocket(this.url, { headers: this.headers, maxPayload: 2 * 1024 * 1024 });
    this.ws.setMaxListeners(50);
    this.ws.on("message", (raw) => this.handleMessage(rawDataToString(raw)));
    this.ws.on("error", (err) => {
      this.rejectChallenge(err instanceof Error ? err : new Error(String(err)));
      this.failPending(err instanceof Error ? err : new Error(String(err)));
    });
    this.ws.on("close", (code, reason) => {
      const error = new Error(`gateway closed (${code}): ${rawDataToString(reason)}`);
      this.rejectChallenge(error);
      this.failPending(error);
    });

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        if (!this.ws) {
          reject(new Error("gateway websocket not initialized"));
          return;
        }
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const onClose = (code: number, reason: Buffer) => {
          cleanup();
          reject(new Error(`gateway closed before open (${code}): ${rawDataToString(reason)}`));
        };
        const cleanup = () => {
          this.ws?.off("open", onOpen);
          this.ws?.off("error", onError);
          this.ws?.off("close", onClose);
        };
        this.ws.once("open", onOpen);
        this.ws.once("error", onError);
        this.ws.once("close", onClose);
      }),
      timeoutMs,
      "gateway websocket open timeout",
    );

    const nonce = await withTimeout(this.challengePromise, timeoutMs, "gateway connect challenge timeout");
    const hello = await this.request<Record<string, unknown> | null>("connect", buildConnectParams(nonce), {
      timeoutMs,
    });
    return hello;
  }

  async request<T>(method: string, params: unknown, opts: GatewayClientRequestOptions): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    const id = randomUUID();
    const frame: GatewayRequestFrame = { type: "req", id, method, params };
    const payload = JSON.stringify(frame);
    const requestPromise = new Promise<T>((resolve, reject) => {
      const timer =
        opts.timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`gateway request timeout (${method})`));
            }, opts.timeoutMs)
          : null;
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal: opts.expectFinal === true,
        timer,
      });
    });
    this.ws.send(payload);
    return requestPromise;
  }

  close() {
    if (!this.ws) return;
    this.ws.close(1000, "paperclip-live-complete");
    this.ws = null;
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private failPending(err: Error) {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (isEventFrame(parsed)) {
      if (parsed.event === "connect.challenge") {
        const payload = asRecord(parsed.payload);
        const nonce = nonEmpty(payload?.nonce);
        if (nonce) {
          this.resolveChallenge(nonce);
          return;
        }
      }
      void Promise.resolve(this.onEvent(parsed)).catch(() => undefined);
      return;
    }

    if (!isResponseFrame(parsed)) return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    const payload = asRecord(parsed.payload);
    const status = nonEmpty(payload?.status)?.toLowerCase();
    if (pending.expectFinal && status === "accepted") {
      return;
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(parsed.id);

    if (parsed.ok) {
      pending.resolve(parsed.payload ?? null);
      return;
    }

    const errorRecord = asRecord(parsed.error);
    const message = nonEmpty(errorRecord?.message) ?? nonEmpty(errorRecord?.code) ?? "gateway request failed";
    const err = new Error(message) as GatewayResponseError;
    const code = nonEmpty(errorRecord?.code);
    const details = asRecord(errorRecord?.details);
    if (code) err.gatewayCode = code;
    if (details) err.gatewayDetails = details;
    pending.reject(err);
  }
}

function uniqueScopes(scopes: string[]): string[] {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));
}

function getGatewayErrorDetails(err: unknown): Record<string, unknown> | null {
  if (!err || typeof err !== "object") return null;
  const candidate = (err as GatewayResponseError).gatewayDetails;
  return asRecord(candidate);
}

function extractPairingRequestId(err: unknown): string | null {
  const details = getGatewayErrorDetails(err);
  const fromDetails = nonEmpty(details?.requestId);
  if (fromDetails) return fromDetails;
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/requestId\s*[:=]\s*([A-Za-z0-9_-]+)/i);
  return match?.[1] ?? null;
}

async function autoApproveDevicePairing(params: {
  url: string;
  headers: Record<string, string>;
  connectTimeoutMs: number;
  clientId: string;
  clientMode: string;
  clientVersion: string;
  role: string;
  scopes: string[];
  authToken: string | null;
  password: string | null;
  requestId: string | null;
  deviceId: string | null;
}): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }> {
  if (!params.authToken && !params.password) {
    return { ok: false, reason: "shared auth token/password is missing" };
  }

  const approvalScopes = uniqueScopes([...params.scopes, "operator.pairing"]);
  const client = new GatewayWsClient(params.url, params.headers, () => {});

  try {
    await client.connect(
      () => ({
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: params.clientId,
          version: params.clientVersion,
          platform: process.platform,
          mode: params.clientMode,
        },
        role: params.role,
        scopes: approvalScopes,
        auth: {
          ...(params.authToken ? { token: params.authToken } : {}),
          ...(params.password ? { password: params.password } : {}),
        },
      }),
      params.connectTimeoutMs,
    );

    let requestId = params.requestId;
    if (!requestId) {
      const listPayload = await client.request<Record<string, unknown>>("device.pair.list", {}, {
        timeoutMs: params.connectTimeoutMs,
      });
      const pending = Array.isArray(listPayload.pending) ? listPayload.pending : [];
      const pendingRecords = pending
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry));
      const matching =
        (params.deviceId
          ? pendingRecords.find((entry) => nonEmpty(entry.deviceId) === params.deviceId)
          : null) ?? pendingRecords[pendingRecords.length - 1];
      requestId = nonEmpty(matching?.requestId);
    }

    if (!requestId) {
      return { ok: false, reason: "no pending device pairing request found" };
    }

    await client.request(
      "device.pair.approve",
      { requestId },
      { timeoutMs: params.connectTimeoutMs },
    );

    return { ok: true, requestId };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

type OpenClawLiveSessionInput = {
  issueId: string;
  sessionKey: string;
  openclawHome: string;
  adapterConfig: Record<string, unknown>;
};

class OpenClawLiveConversationSession {
  private client: GatewayWsClient | null = null;
  private subscribedSessionKey: string | null = null;
  private activeRunId: string | null = null;
  private currentUserItem: IssueConversationItem | null = null;
  private currentAssistantItem: IssueConversationItem | null = null;
  private assistantTextByRunId = new Map<string, string>();
  private liveItems = new Map<string, IssueConversationItem>();
  private runtimeInfoState: {
    model: string | null;
    provider: string | null;
    thinking: string | null;
    reasoning: string | null;
    metadataJson: Record<string, unknown> | null;
  } = {
    model: null,
    provider: null,
    thinking: null,
    reasoning: null,
    metadataJson: null,
  };
  private lastError: string | null = null;
  private waitTimeoutMs: number;
  private connectTimeoutMs: number;
  private parsedUrl: URL;
  private headers: Record<string, string>;
  private authToken: string | null;
  private password: string | null;
  private clientId: string;
  private clientMode: string;
  private clientVersion: string;
  private role: string;
  private scopes: string[];
  private deviceFamily: string | null;
  private disableDeviceAuth: boolean;

  constructor(private readonly input: OpenClawLiveSessionInput) {
    const urlValue = nonEmpty(input.adapterConfig.url);
    if (!urlValue) {
      throw new Error("OpenClaw gateway adapter requires a WebSocket URL.");
    }
    const parsedUrl = normalizeUrl(urlValue);
    if (!parsedUrl || (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:")) {
      throw new Error("OpenClaw gateway adapter requires a valid ws:// or wss:// URL.");
    }
    this.parsedUrl = parsedUrl;

    this.waitTimeoutMs = parseOptionalPositiveInteger(input.adapterConfig.waitTimeoutMs) ?? 120_000;
    this.connectTimeoutMs = Math.min(this.waitTimeoutMs, 15_000);
    this.headers = toStringRecord(input.adapterConfig.headers);
    this.authToken = resolveAuthToken(parseObject(input.adapterConfig), this.headers);
    this.password = nonEmpty(input.adapterConfig.password);
    if (this.authToken && !headerMapHasIgnoreCase(this.headers, "authorization")) {
      this.headers.authorization = toAuthorizationHeaderValue(this.authToken);
    }
    this.clientId = nonEmpty(input.adapterConfig.clientId) ?? DEFAULT_CLIENT_ID;
    this.clientMode = nonEmpty(input.adapterConfig.clientMode) ?? DEFAULT_CLIENT_MODE;
    this.clientVersion = nonEmpty(input.adapterConfig.clientVersion) ?? DEFAULT_CLIENT_VERSION;
    this.role = nonEmpty(input.adapterConfig.role) ?? DEFAULT_ROLE;
    this.scopes = uniqueScopes([...normalizeScopes(input.adapterConfig.scopes), "operator.read"]);
    this.deviceFamily = nonEmpty(input.adapterConfig.deviceFamily);
    this.disableDeviceAuth = parseBoolean(input.adapterConfig.disableDeviceAuth, false);
    this.runtimeInfoState = {
      model: nonEmpty(input.adapterConfig.model),
      provider: nonEmpty(input.adapterConfig.provider) ?? "openclaw",
      thinking: nonEmpty(input.adapterConfig.thinkingLevel),
      reasoning: nonEmpty(input.adapterConfig.reasoningLevel),
      metadataJson: {
        agentId: nonEmpty(input.adapterConfig.agentId),
        sessionKeyStrategy: nonEmpty(input.adapterConfig.sessionKeyStrategy),
      },
    };
  }

  private async ensureConnected() {
    if (this.client?.isOpen()) return;
    if (this.client && !this.client.isOpen()) {
      this.client.close();
      this.client = null;
      this.subscribedSessionKey = null;
    }
    const client = new GatewayWsClient(this.parsedUrl.toString(), this.headers, (frame) => this.onEvent(frame));

    const connect = async () => {
      const deviceIdentity = this.disableDeviceAuth
        ? null
        : resolveDeviceIdentity({
          ...parseObject(this.input.adapterConfig),
          openclawHomeDir: this.input.openclawHome,
        });
      return client.connect((nonce) => {
        const signedAtMs = Date.now();
        const connectParams: Record<string, unknown> = {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: this.clientId,
            version: this.clientVersion,
            platform: process.platform,
            ...(this.deviceFamily ? { deviceFamily: this.deviceFamily } : {}),
            mode: this.clientMode,
          },
          role: this.role,
          scopes: this.scopes,
          auth:
            this.authToken || this.password
              ? {
                ...(this.authToken ? { token: this.authToken } : {}),
                ...(this.password ? { password: this.password } : {}),
              }
              : undefined,
        };

        if (deviceIdentity) {
          const payload = buildDeviceAuthPayloadV3({
            deviceId: deviceIdentity.deviceId,
            clientId: this.clientId,
            clientMode: this.clientMode,
            role: this.role,
            scopes: this.scopes,
            signedAtMs,
            token: this.authToken,
            nonce,
            platform: process.platform,
            deviceFamily: this.deviceFamily,
          });
          connectParams.device = {
            id: deviceIdentity.deviceId,
            publicKey: deviceIdentity.publicKeyRawBase64Url,
            signature: signDevicePayload(deviceIdentity.privateKeyPem, payload),
            signedAt: signedAtMs,
            nonce,
          };
        }

        return connectParams;
      }, this.connectTimeoutMs).then(() => ({ deviceIdentity }));
    };

    try {
      await connect();
      this.client = client;
      await this.syncSessionSubscription();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pairingRequired = message.toLowerCase().includes("pairing required");
      if (pairingRequired && !this.disableDeviceAuth) {
        const deviceIdentity = this.disableDeviceAuth
          ? null
          : resolveDeviceIdentity({
            ...parseObject(this.input.adapterConfig),
            openclawHomeDir: this.input.openclawHome,
          });
        const pairResult = await autoApproveDevicePairing({
          url: this.parsedUrl.toString(),
          headers: this.headers,
          connectTimeoutMs: this.connectTimeoutMs,
          clientId: this.clientId,
          clientMode: this.clientMode,
          clientVersion: this.clientVersion,
          role: this.role,
          scopes: this.scopes,
          authToken: this.authToken,
          password: this.password,
          requestId: extractPairingRequestId(error),
          deviceId: deviceIdentity?.deviceId ?? null,
        });
        if (pairResult.ok) {
          await connect();
          this.client = client;
          await this.syncSessionSubscription();
          return;
        }
      }
      client.close();
      this.subscribedSessionKey = null;
      throw error;
    }
  }

  private resolveCanonicalSessionKey() {
    return resolveOpenClawSessionSummary(this.input.openclawHome, this.input.sessionKey, 500)?.sessionKey ?? null;
  }

  private currentSessionKey() {
    return this.resolveCanonicalSessionKey() ?? this.input.sessionKey;
  }

  private async syncSessionSubscription() {
    if (!this.client) return;
    const sessionKey = this.currentSessionKey();
    if (this.subscribedSessionKey === sessionKey) return;
    await this.client.request("sessions.subscribe", {}, { timeoutMs: this.connectTimeoutMs });
    await this.client.request(
      "sessions.messages.subscribe",
      { key: sessionKey },
      { timeoutMs: this.connectTimeoutMs },
    );
    await this.client.request(
      "sessions.patch",
      {
        key: sessionKey,
        execSecurity: "full",
        execAsk: "off",
      },
      { timeoutMs: this.connectTimeoutMs },
    );
    this.subscribedSessionKey = sessionKey;
  }

  private onEvent(frame: GatewayEventFrame) {
    const expectedSessionKey = this.currentSessionKey();
    if (frame.event === "session.message") {
      const payload = asRecord(frame.payload);
      if (!payload || nonEmpty(payload.sessionKey) !== expectedSessionKey) return;
      const item = mapSessionMessagePayloadToItem(payload);
      if (!item) return;
      const nextMetadata = {
        totalTokens: typeof payload.totalTokens === "number" ? payload.totalTokens : undefined,
        estimatedCostUsd: typeof payload.estimatedCostUsd === "number" ? payload.estimatedCostUsd : undefined,
        contextTokens: typeof payload.contextTokens === "number" ? payload.contextTokens : undefined,
        messageSeq: typeof payload.messageSeq === "number" ? payload.messageSeq : undefined,
      };
      item.kind = "message";
      item.metadataJson = Object.values(nextMetadata).some((value) => value !== undefined) ? nextMetadata : null;
      this.liveItems.set(item.id, item);
      if (item.role === "assistant") {
        this.currentAssistantItem = item;
      }
      this.runtimeInfoState = {
        model: nonEmpty(payload.model) ?? this.runtimeInfoState.model,
        provider: nonEmpty(payload.modelProvider) ?? this.runtimeInfoState.provider,
        thinking: this.runtimeInfoState.thinking,
        reasoning: this.runtimeInfoState.reasoning,
        metadataJson: {
          ...(this.runtimeInfoState.metadataJson ?? {}),
          ...nextMetadata,
        },
      };
      return;
    }

    if (frame.event === "session.tool") {
      const payload = asRecord(frame.payload);
      if (!payload || nonEmpty(payload.sessionKey) !== expectedSessionKey) return;
      const toolName = nonEmpty(payload.toolName) ?? nonEmpty(payload.name) ?? "tool";
      const itemId = nonEmpty(payload.messageId) ?? nonEmpty(payload.id) ?? `tool:${toolName}`;
      this.liveItems.set(itemId, {
        id: itemId,
        role: "tool",
        text:
          nonEmpty(payload.summary) ??
          nonEmpty(payload.outputText) ??
          nonEmpty(payload.error) ??
          `[tool:${toolName}]`,
        createdAt: asIsoTimestamp(payload.timestamp ?? payload.ts),
        source: "openclaw",
        kind: "tool_call",
        title: toolName,
        status:
          nonEmpty(payload.status)?.toLowerCase() === "error"
            ? "failed"
            : nonEmpty(payload.status)?.toLowerCase() === "completed"
              ? "completed"
              : "in_progress",
        metadataJson: {
          toolName,
          status: nonEmpty(payload.status),
          input: asRecord(payload.input) ?? payload.input ?? null,
          output: asRecord(payload.output) ?? payload.output ?? null,
        },
        rawType: "tool",
      });
      return;
    }

    if (frame.event === "sessions.changed") {
      const payload = asRecord(frame.payload);
      if (!payload || nonEmpty(payload.sessionKey) !== expectedSessionKey) return;
      const status = nonEmpty(payload.status)?.toLowerCase();
      if (status === "running" || status === "started") {
        this.activeRunId = nonEmpty(payload.runId) ?? this.activeRunId ?? "openclaw-active";
      } else if (status === "idle" || status === "ok" || status === "completed" || status === "error") {
        this.activeRunId = null;
      }
      this.runtimeInfoState = {
        model: nonEmpty(payload.model) ?? this.runtimeInfoState.model,
        provider: nonEmpty(payload.modelProvider) ?? this.runtimeInfoState.provider,
        thinking: nonEmpty(payload.thinkingLevel) ?? this.runtimeInfoState.thinking,
        reasoning: nonEmpty(payload.reasoningLevel) ?? this.runtimeInfoState.reasoning,
        metadataJson: {
          ...(this.runtimeInfoState.metadataJson ?? {}),
          status: nonEmpty(payload.status),
          totalTokens: typeof payload.totalTokens === "number" ? payload.totalTokens : (this.runtimeInfoState.metadataJson as Record<string, unknown> | null)?.totalTokens,
          estimatedCostUsd:
            typeof payload.estimatedCostUsd === "number"
              ? payload.estimatedCostUsd
              : (this.runtimeInfoState.metadataJson as Record<string, unknown> | null)?.estimatedCostUsd,
          contextTokens:
            typeof payload.contextTokens === "number"
              ? payload.contextTokens
              : (this.runtimeInfoState.metadataJson as Record<string, unknown> | null)?.contextTokens,
        },
      };
      return;
    }

    if (frame.event !== "agent") return;
    const payload = asRecord(frame.payload);
    if (!payload) return;
    const runId = nonEmpty(payload.runId);
    if (!runId) return;

    const stream = nonEmpty(payload.stream)?.toLowerCase() ?? "";
    const data = asRecord(payload.data) ?? {};
    if (stream === "assistant") {
      const delta = nonEmpty(data.delta);
      const text = nonEmpty(data.text);
      const nextText =
        delta
          ? `${this.assistantTextByRunId.get(runId) ?? ""}${delta}`
          : text ?? this.assistantTextByRunId.get(runId) ?? "";
      this.assistantTextByRunId.set(runId, nextText);
      if (this.activeRunId === runId) {
        this.currentAssistantItem = {
          id: `${runId}:assistant`,
          role: "assistant",
          text: nextText,
          createdAt: null,
          source: "openclaw",
          rawType: "assistant",
        };
      }
      return;
    }

    if (!this.activeRunId || runId !== this.activeRunId) return;

    if (stream === "error") {
      this.lastError = nonEmpty(data.error) ?? nonEmpty(data.message) ?? this.lastError;
      return;
    }

    if (stream === "lifecycle") {
      const phase = nonEmpty(data.phase)?.toLowerCase();
      if (phase === "error" || phase === "failed" || phase === "cancelled") {
        this.lastError = nonEmpty(data.error) ?? nonEmpty(data.message) ?? this.lastError;
      }
    }
  }

  private async startRun(method: "sessions.send" | "sessions.steer", params: Record<string, unknown>, userText: string) {
    const execute = async () => {
      await this.ensureConnected();
      if (!this.client) throw new Error("OpenClaw gateway connection is not available.");
      await this.syncSessionSubscription();

      this.lastError = null;
      return this.client.request<Record<string, unknown>>(method, params, {
        timeoutMs: this.connectTimeoutMs,
      });
    };

    let result: Record<string, unknown>;
    try {
      result = await execute();
    } catch (error) {
      if (error instanceof Error && /gateway not connected/i.test(error.message)) {
        this.client?.close();
        this.client = null;
        this.subscribedSessionKey = null;
        result = await execute();
      } else {
        throw error;
      }
    }
    const runId =
      nonEmpty(result.runId) ?? nonEmpty(params.idempotencyKey) ?? randomUUID();

    this.activeRunId = runId;
    this.currentUserItem = {
      id: `${runId}:user`,
      role: "user",
      text: userText,
      createdAt: new Date().toISOString(),
      source: "openclaw",
      rawType: "user",
    };
    this.currentAssistantItem = {
      id: `${runId}:assistant`,
      role: "assistant",
      text: this.assistantTextByRunId.get(runId) ?? "",
      createdAt: null,
      source: "openclaw",
      rawType: "assistant",
    };

    void this.waitForRun(runId);
    return runId;
  }

  private async waitForRun(runId: string) {
    try {
      if (!this.client) return;
      const waitPayload = await this.client.request<Record<string, unknown>>(
        "agent.wait",
        { runId, timeoutMs: this.waitTimeoutMs },
        { timeoutMs: this.waitTimeoutMs + this.connectTimeoutMs },
      );
      const waitStatus = nonEmpty(waitPayload.status)?.toLowerCase() ?? "";
      if (waitStatus === "error") {
        this.lastError = nonEmpty(waitPayload.error) ?? this.lastError ?? "OpenClaw gateway run failed";
      }
      if (waitStatus === "timeout") {
        this.lastError = `OpenClaw gateway run timed out after ${this.waitTimeoutMs}ms`;
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.activeRunId === runId) {
        this.activeRunId = null;
        this.assistantTextByRunId.delete(runId);
      }
    }
  }

  async send(inputText: string) {
    return this.startRun(
      "sessions.send",
      {
        key: this.currentSessionKey(),
        message: inputText,
        timeoutMs: this.waitTimeoutMs,
        idempotencyKey: randomUUID(),
      },
      inputText,
    );
  }

  async steer(inputText: string) {
    if (!this.activeRunId) {
      throw new Error("No active OpenClaw session run to steer.");
    }
    return this.startRun(
      "sessions.steer",
      {
        key: this.currentSessionKey(),
        message: inputText,
        timeoutMs: this.waitTimeoutMs,
        idempotencyKey: randomUUID(),
      },
      inputText,
    );
  }

  async interrupt() {
    const interruptedRunId = this.activeRunId;
    await this.ensureConnected();
    if (!this.client) return interruptedRunId;
    try {
      await this.client.request(
        "sessions.abort",
        {
          key: this.currentSessionKey(),
          ...(interruptedRunId ? { runId: interruptedRunId } : {}),
        },
        { timeoutMs: this.connectTimeoutMs },
      );
    } finally {
      this.activeRunId = null;
      this.lastError = null;
      this.client.close();
      this.client = null;
      this.subscribedSessionKey = null;
    }
    return interruptedRunId;
  }

  async snapshot(issueId: string, runtimeLink: IssueRuntimeLink, limit = 100): Promise<IssueConversationSnapshot> {
    try {
      await this.ensureConnected();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }

    const persistedSnapshot = readOpenClawConversationSnapshotFromHome(
      this.input.openclawHome,
      this.input.sessionKey,
      limit,
    );
    let persistedItems = persistedSnapshot.items;
    const resolvedSessionKey = this.currentSessionKey();
    if (persistedItems.length === 0 && this.client) {
      try {
        await this.syncSessionSubscription();
        const historyPayload = await this.client.request<Record<string, unknown>>(
          "chat.history",
          { sessionKey: resolvedSessionKey, limit },
          { timeoutMs: this.connectTimeoutMs },
        );
        const historyMessages = Array.isArray(historyPayload.messages)
          ? historyPayload.messages.filter(
              (entry): entry is Record<string, unknown> =>
                typeof entry === "object" && entry !== null && !Array.isArray(entry),
            )
          : [];
        if (historyMessages.length > 0) {
          persistedItems = mapOpenClawSessionMessages(historyMessages, limit);
          const assistantHistory = [...historyMessages].reverse().find(
            (entry) => typeof entry.role === "string" && entry.role === "assistant",
          );
          this.runtimeInfoState = {
            model:
              nonEmpty(assistantHistory?.model) ??
              nonEmpty(assistantHistory?.modelId) ??
              this.runtimeInfoState.model,
            provider:
              nonEmpty(assistantHistory?.provider) ??
              nonEmpty(assistantHistory?.modelProvider) ??
              this.runtimeInfoState.provider,
            thinking: nonEmpty(historyPayload.thinkingLevel) ?? this.runtimeInfoState.thinking,
            reasoning: this.runtimeInfoState.reasoning,
            metadataJson: {
              ...(this.runtimeInfoState.metadataJson ?? {}),
              ...(typeof historyPayload.truncated === "boolean" ? { truncated: historyPayload.truncated } : {}),
            },
          };
        }
      } catch {
        // Ignore and fall through to the older gateway session endpoint.
      }
    }
    if (persistedItems.length === 0 && this.client) {
      try {
        const sessionPayload = await this.client.request<Record<string, unknown>>(
          "sessions.get",
          { key: resolvedSessionKey, limit },
          { timeoutMs: this.connectTimeoutMs },
        );
        const messages = Array.isArray(sessionPayload.messages)
          ? sessionPayload.messages.filter(
              (entry): entry is Record<string, unknown> =>
                typeof entry === "object" && entry !== null && !Array.isArray(entry),
            )
          : [];
        if (messages.length > 0) {
          persistedItems = mapOpenClawSessionMessages(messages, limit);
        }
      } catch {
        // Ignore and fall back to whatever local transcript data we have.
      }
    }

    const recentPersistedTexts = new Set(
      persistedItems.slice(-6).map((item) => `${item.role}:${item.text}`),
    );
    const ephemeralItems = [
      ...this.liveItems.values(),
      this.currentUserItem,
      this.currentAssistantItem,
    ]
      .filter((item): item is IssueConversationItem => Boolean(item && item.text.trim().length > 0))
      .filter((item) => this.activeRunId != null || !recentPersistedTexts.has(`${item.role}:${item.text}`));

    return {
      issueId,
      runtimeLink,
      sourceStatus: "ok",
      activeTurnId: this.activeRunId,
      isStreaming: this.activeRunId != null,
      runtimeInfo: {
        runtimeKind: "openclaw",
        externalConversationId: runtimeLink.externalConversationId,
        externalConversationLabel: runtimeLink.externalConversationLabel,
        model: this.runtimeInfoState.model ?? persistedSnapshot.model,
        provider: this.runtimeInfoState.provider ?? persistedSnapshot.provider ?? "openclaw",
        thinking: this.runtimeInfoState.thinking ?? persistedSnapshot.thinking,
        reasoning: this.runtimeInfoState.reasoning ?? persistedSnapshot.reasoning,
        sessionKey: resolvedSessionKey,
        metadataJson:
          this.runtimeInfoState.metadataJson ??
          persistedSnapshot.metadataJson ??
          runtimeLink.metadataJson ??
          null,
      },
      pendingApprovals: [],
      items: [...persistedItems, ...ephemeralItems].slice(-Math.max(1, limit)),
      error: this.lastError,
    };
  }
}

const openClawLiveSessions = new Map<string, OpenClawLiveConversationSession>();

function sessionMapKey(issueId: string, sessionKey: string, openclawHome: string) {
  return `${issueId}::${sessionKey}::${openclawHome}`;
}

export function getOrCreateOpenClawLiveConversationSession(input: OpenClawLiveSessionInput) {
  const key = sessionMapKey(input.issueId, input.sessionKey, input.openclawHome);
  let session = openClawLiveSessions.get(key);
  if (!session) {
    session = new OpenClawLiveConversationSession(input);
    openClawLiveSessions.set(key, session);
  }
  return session;
}

export function getExistingOpenClawLiveConversationSession(issueId: string, sessionKey: string, openclawHome: string) {
  return openClawLiveSessions.get(sessionMapKey(issueId, sessionKey, openclawHome)) ?? null;
}
