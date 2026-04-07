import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("openclaw gateway sessionCodec", () => {
  it("serializes and deserializes a sessionKey", () => {
    expect(sessionCodec.serialize({ sessionKey: "agent:main:main" })).toEqual({
      sessionKey: "agent:main:main",
    });
    expect(sessionCodec.deserialize({ sessionKey: "agent:main:main" })).toEqual({
      sessionKey: "agent:main:main",
    });
    expect(sessionCodec.getDisplayId?.({ sessionKey: "agent:main:main" })).toBe("agent:main:main");
  });
});
