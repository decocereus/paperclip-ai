import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { PaperclipApiClient } from "../../client/http.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface RawApiOptions extends BaseClientOptions {
  body?: string;
  bodyFile?: string;
  runId?: string;
}

function parseBody(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

async function resolveBody(options: RawApiOptions): Promise<unknown | undefined> {
  if (options.bodyFile?.trim()) {
    const fileContents = await readFile(options.bodyFile.trim(), "utf8");
    return parseBody(fileContents);
  }
  if (typeof options.body === "string") {
    return parseBody(options.body);
  }
  return undefined;
}

export function registerRawApiCommands(program: Command): void {
  addCommonClientOptions(
    program
      .command("api")
      .description("Make a raw Paperclip API request using env/context auth")
      .argument("<method>", "HTTP method (get, post, patch, put, delete)")
      .argument("<path>", "API path, for example /api/agents/me")
      .option("--body <json>", "JSON request body")
      .option("--body-file <path>", "Path to JSON body file")
      .option("--run-id <id>", "Override X-Paperclip-Run-Id (defaults to PAPERCLIP_RUN_ID)")
      .action(async (method: string, requestPath: string, options: RawApiOptions) => {
        try {
          const ctx = resolveCommandContext(options);
          const body = await resolveBody(options);
          const runId = options.runId?.trim() || process.env.PAPERCLIP_RUN_ID?.trim() || undefined;
          const api = new PaperclipApiClient({
            apiBase: ctx.api.apiBase,
            apiKey: ctx.api.apiKey,
            runId,
          });

          const normalizedMethod = method.trim().toUpperCase();
          let result: unknown;
          switch (normalizedMethod) {
            case "GET":
              result = await api.get(requestPath);
              break;
            case "POST":
              result = await api.post(requestPath, body);
              break;
            case "PATCH":
              result = await api.patch(requestPath, body);
              break;
            case "PUT":
              result = await api.put(requestPath, body);
              break;
            case "DELETE":
              result = await api.delete(requestPath);
              break;
            default:
              throw new Error(`Unsupported method: ${method}`);
          }

          printOutput(result, { json: options.json ?? true });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
