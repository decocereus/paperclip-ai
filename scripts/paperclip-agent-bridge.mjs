#!/usr/bin/env node

import http from "node:http";
import { resolveBridgeApiKey } from "./paperclip-agent-auth.mjs";

const args = process.argv.slice(2);

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseBody(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

const method = args.shift()?.trim().toUpperCase();
const requestPath = args.shift()?.trim();

if (!method || !requestPath) {
  fail("Usage: paperclip-agent-bridge.mjs <METHOD> <PATH> [--body <json>] [--json]");
}

let body = undefined;
let jsonOnly = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--json") {
    jsonOnly = true;
    continue;
  }
  if (arg === "--body") {
    const next = args[index + 1];
    if (typeof next !== "string") {
      fail("--body requires a value");
    }
    body = parseBody(next);
    index += 1;
    continue;
  }
}

const apiBase = process.env.PAPERCLIP_API_URL?.trim();
const apiKey = resolveBridgeApiKey(process.env);
const runId = process.env.PAPERCLIP_RUN_ID?.trim();

if (!apiBase) fail("PAPERCLIP_API_URL is required");
if (!apiKey) fail("PAPERCLIP_API_KEY is required");

const url = new URL(requestPath.startsWith("/") ? requestPath : `/${requestPath}`, apiBase);
const headers = {
  accept: "application/json",
  authorization: `Bearer ${apiKey}`,
};
if (runId) {
  headers["x-paperclip-run-id"] = runId;
}
if (body !== undefined) {
  headers["content-type"] = "application/json";
}

const socketPath = process.env.PAPERCLIP_BRIDGE_SOCKET_PATH?.trim() || null;

async function requestViaSocket() {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({
            ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
            status: res.statusCode ?? 500,
            text,
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

const response = socketPath
  ? await requestViaSocket()
  : await (async () => {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      ok: res.ok,
      status: res.status,
      text: await res.text(),
    };
  })();

const parsed = response.text.trim()
  ? (() => {
    try {
      return JSON.parse(response.text);
    } catch {
      return response.text;
    }
  })()
  : null;

if (!response.ok) {
  if (jsonOnly && parsed && typeof parsed === "object") {
    console.log(JSON.stringify(parsed));
  } else if (typeof parsed === "string" && parsed.trim()) {
    console.error(parsed);
  } else if (parsed && typeof parsed === "object") {
    console.error(JSON.stringify(parsed, null, 2));
  } else {
    console.error(`Request failed with status ${response.status}`);
  }
  process.exit(1);
}

if (jsonOnly) {
  console.log(JSON.stringify(parsed));
} else if (parsed && typeof parsed === "object") {
  console.log(JSON.stringify(parsed, null, 2));
} else if (parsed !== null) {
  console.log(String(parsed));
}
