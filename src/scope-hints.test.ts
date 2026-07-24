import { describe, it, expect } from "vitest";
import { parseHotfixList, isHotfix, buildScopeHint } from "./scope-hints.js";

function makeContext(overrides: Partial<{ title: string; body: string; labels: string[] }> = {}) {
  return {
    title: "Fix null pointer in login",
    body: "This PR fixes the null pointer reported in the crashlytics dashboard.",
    labels: [] as string[],
    ...overrides,
  };
}

describe("parseHotfixList", () => {
  it("parses comma-separated values", () => {
    expect(parseHotfixList("hotfix, urgent , CRITICAL")).toEqual(["hotfix", "urgent", "critical"]);
  });

  it("returns empty for empty string", () => {
    expect(parseHotfixList("")).toEqual([]);
  });
});

describe("isHotfix", () => {
  it("detects hotfix by label", () => {
    const context = makeContext({ labels: ["bug", "hotfix"] });
    expect(isHotfix(context, ["hotfix", "urgent"], ["hotfix"])).toBe(true);
  });

  it("detects hotfix by title keyword", () => {
    const context = makeContext({ title: "[HOTFIX] Fix crash on startup" });
    expect(isHotfix(context, ["hotfix"], ["hotfix"])).toBe(true);
  });

  it("detects hotfix by body keyword", () => {
    const context = makeContext({ body: "This is an urgent bug fix for the checkout flow." });
    expect(isHotfix(context, ["hotfix"], ["urgent", "bug fix"])).toBe(true);
  });

  it("returns false when no match", () => {
    const context = makeContext({ title: "Refactor settings screen", labels: ["refactor"] });
    expect(isHotfix(context, ["hotfix", "urgent"], ["hotfix"])).toBe(false);
  });
});

describe("buildScopeHint", () => {
  it("returns scope hint for hotfix", () => {
    const context = makeContext({ labels: ["hotfix"] });
    const hint = buildScopeHint(context, ["hotfix"], ["hotfix"]);
    expect(hint).toContain("This PR is flagged as an urgent bugfix or hotfix");
    expect(hint).toContain("Do NOT request refactoring of pre-existing shared components");
  });

  it("returns empty string for regular PR", () => {
    const context = makeContext();
    const hint = buildScopeHint(context, ["hotfix"], ["hotfix"]);
    expect(hint).toBe("");
  });
});
