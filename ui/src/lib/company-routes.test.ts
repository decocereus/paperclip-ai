import { describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  companyRouteKey,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  matchesCompanyRouteKey,
  slugifyCompanyName,
  toCompanyRelativePath,
} from "./company-routes";

describe("company routes", () => {
  it("treats execution workspace paths as board routes that need a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123")).toBe(true);
    expect(extractCompanyPrefixFromPath("/execution-workspaces/workspace-123")).toBeNull();
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123", "PAP")).toBe(
      "/pap/execution-workspaces/workspace-123",
    );
  });

  it("normalizes prefixed execution workspace paths back to company-relative paths", () => {
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123")).toBe(
      "/execution-workspaces/workspace-123",
    );
  });

  it("derives company route keys from company names and keeps prefix fallback matching", () => {
    const company = { id: "c1", name: "Deco Cereus", issuePrefix: "DEC" };
    expect(slugifyCompanyName(company.name)).toBe("deco-cereus");
    expect(companyRouteKey(company)).toBe("deco-cereus");
    expect(matchesCompanyRouteKey(company, "deco-cereus")).toBe(true);
    expect(matchesCompanyRouteKey(company, "DEC")).toBe(true);
  });
});
