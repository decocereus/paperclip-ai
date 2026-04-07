export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionKey = readNonEmptyString(record.sessionKey) ?? readNonEmptyString(record.session_key);
    if (!sessionKey) return null;
    return { sessionKey };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionKey = readNonEmptyString(params.sessionKey) ?? readNonEmptyString(params.session_key);
    if (!sessionKey) return null;
    return { sessionKey };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionKey) ?? readNonEmptyString(params.session_key);
  },
};
