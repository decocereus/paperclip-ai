import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { detectRuntimeSources } from "@paperclipai/shared/runtime-sources";

export function runtimeSourcesCheck(config: PaperclipConfig): CheckResult {
  const configuredCount = Object.keys(config.runtimeSources ?? {}).length;
  if (configuredCount > 0) {
    return {
      name: "Runtime sources",
      status: "pass",
      message: `Configured ${configuredCount} linked runtime source${configuredCount === 1 ? "" : "s"}`,
    };
  }

  const discovered = detectRuntimeSources(process.env).filter((entry) => entry.status === "available");
  if (discovered.length > 0) {
    return {
      name: "Runtime sources",
      status: "warn",
      message: `Detected local runtime homes (${discovered.map((entry) => entry.kind).join(", ")}) but none are linked yet`,
      canRepair: false,
      repairHint: "Run `paperclipai sources detect` then `paperclipai sources link`",
    };
  }

  return {
    name: "Runtime sources",
    status: "pass",
    message: "No linked runtime sources configured and no default local sources detected",
  };
}
