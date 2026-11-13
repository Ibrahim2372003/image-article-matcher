import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.AI_PROVIDER).toBe("mock");
  });
  it("requires GEMINI_API_KEY for the gemini provider", () => {
    expect(() => loadEnv({ AI_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
  });
  it("rejects invalid values without echoing them", () => {
    expect(() => loadEnv({ PORT: "99999", API_KEY: "short" })).toThrow(/Invalid environment configuration/);
  });
});
