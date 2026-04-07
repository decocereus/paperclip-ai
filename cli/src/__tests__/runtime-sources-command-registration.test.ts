import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerRuntimeSourceCommands } from "../commands/runtime-sources.js";

describe("registerRuntimeSourceCommands", () => {
  it("registers sources commands", () => {
    const program = new Command();

    expect(() => registerRuntimeSourceCommands(program)).not.toThrow();

    const sources = program.commands.find((command) => command.name() === "sources");
    expect(sources).toBeDefined();
    expect(sources?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["detect", "show", "link", "openclaw-token"]),
    );
  });
});
