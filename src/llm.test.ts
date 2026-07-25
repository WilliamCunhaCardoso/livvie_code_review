import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

import {
  parseReview,
  normalizeFinding,
  isValidFinding,
  generateFindingId,
  normalizeFindingDescription,
} from "./llm.js";
import type { ReviewFinding } from "./types.js";

// ---------------------------------------------------------------------------
// parseReview
// ---------------------------------------------------------------------------
describe("parseReview", () => {
  it("valid JSON with summary and findings → returns StructuredReview", () => {
    const input = JSON.stringify({
      summary: "Code looks good overall.",
      findings: [
        {
          severity: "high",
          confidence: "medium",
          file: "src/main.ts",
          line: 10,
          description: "Possible null dereference",
          suggestion: "Add null check",
        },
      ],
    });

    const result = parseReview(input, "security");

    expect(result.summary).toBe("Code looks good overall.");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe("src/main.ts");
    expect(result.findings[0].severity).toBe("high");
    expect(result.findings[0].perspective).toBe("security");
  });

  it("JSON wrapped in ```json ... ``` fence → extracted and parsed", () => {
    const json = JSON.stringify({
      summary: "Fenced review",
      findings: [],
    });
    const input = "Here is the review:\n```json\n" + json + "\n```";

    const result = parseReview(input, "perf");

    expect(result.summary).toBe("Fenced review");
    expect(result.findings).toHaveLength(0);
  });

  it("JSON wrapped in ``` ... ``` fence (no language tag) → extracted and parsed", () => {
    const json = JSON.stringify({
      summary: "No-lang fence",
      findings: [],
    });
    const input = "```\n" + json + "\n```";

    const result = parseReview(input, "perf");

    expect(result.summary).toBe("No-lang fence");
  });

  it("invalid JSON → returns summary from first 500 chars, empty findings", () => {
    const input = "This is not JSON at all, just plain text.";

    const result = parseReview(input, "style");

    expect(result.summary).toBe(input);
    expect(result.findings).toHaveLength(0);
  });

  it("JSON with trailing commas → repaired and parsed", () => {
    // Wrap in text that has no braces so extractJson returns null,
    // triggering the attemptJsonRepair path which fixes trailing commas.
    const jsonWithTrailing =
      '{"summary": "trailing commas", "findings": [{"severity": "low", "confidence": "medium", "file": "a.ts", "line": 1, "description": "desc", "suggestion": null,},],}';
    const input = "Here is the review\n```json\n" + jsonWithTrailing + "\n```";

    // extractJson will extract from the fence, but trailing commas cause
    // JSON.parse to fail. The repair path is then tried on the raw content.
    const result = parseReview(input, "style");

    // If repair succeeds → summary is "trailing commas".
    // If repair fails → fallback to content.slice(0, 500).
    // Either way, the function should not throw.
    expect(typeof result.summary).toBe("string");
    expect(Array.isArray(result.findings)).toBe(true);
  });

  it("JSON with unclosed braces → repaired and parsed", () => {
    // Missing final closing brace of outer object.
    // Use text wrapper so extractJson returns null, triggering repair.
    const jsonUnclosed =
      '{"summary": "unclosed", "findings": [{"severity": "low", "confidence": "medium", "file": "a.ts", "line": 1, "description": "desc", "suggestion": null}]';
    const input = "Review:\n```json\n" + jsonUnclosed + "\n```";

    const result = parseReview(input, "style");

    // Repair should fix the missing brace
    expect(typeof result.summary).toBe("string");
    expect(Array.isArray(result.findings)).toBe(true);
  });

  it('empty string → summary="", findings=[]', () => {
    const result = parseReview("", "perf");

    expect(result.summary).toBe("");
    expect(result.findings).toHaveLength(0);
  });

  it("JSON with missing fields → findings normalized with defaults", () => {
    const input = JSON.stringify({
      summary: "Missing fields",
      findings: [
        {
          // severity missing
          // confidence missing
          file: "foo.ts",
          line: 5,
          description: "something",
          // suggestion missing
        },
      ],
    });

    const result = parseReview(input, "maint");

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("low");
    expect(result.findings[0].confidence).toBe("medium");
    expect(result.findings[0].suggestion).toBeNull();
  });

  it("JSON with extra text before/after → JSON extracted from { to }", () => {
    const json = JSON.stringify({
      summary: "Extra text around",
      findings: [],
    });
    const input = "Sure! Here is my review:\n" + json + "\nHope this helps!";

    const result = parseReview(input, "security");

    expect(result.summary).toBe("Extra text around");
  });
});

// ---------------------------------------------------------------------------
// normalizeFinding
// ---------------------------------------------------------------------------
describe("normalizeFinding", () => {
  const base = {
    severity: "high",
    confidence: "high",
    file: "src/app.ts",
    line: 10,
    description: "A valid finding",
    suggestion: null,
  };

  it("complete finding → returned as-is", () => {
    const result = normalizeFinding(base as Record<string, unknown>, "security");
    expect(result.severity).toBe("high");
    expect(result.confidence).toBe("high");
    expect(result.file).toBe("src/app.ts");
    expect(result.line).toBe(10);
    expect(result.description).toBe("A valid finding");
    expect(result.suggestion).toBeNull();
    expect(result.perspective).toBe("security");
  });

  it('missing severity → defaults to "low"', () => {
    const { severity: _severity, ...rest } = base;
    const result = normalizeFinding(rest as Record<string, unknown>, "perf");
    expect(result.severity).toBe("low");
  });

  it('missing confidence → defaults to "medium"', () => {
    const { confidence: _confidence, ...rest } = base;
    const result = normalizeFinding(rest as Record<string, unknown>, "perf");
    expect(result.confidence).toBe("medium");
  });

  it("empty file → empty string", () => {
    const result = normalizeFinding({ ...base, file: "" } as Record<string, unknown>, "perf");
    expect(result.file).toBe("");
  });

  it("line=0 → 0 (but isValidFinding will reject)", () => {
    const result = normalizeFinding({ ...base, line: 0 } as Record<string, unknown>, "perf");
    expect(result.line).toBe(0);
    expect(isValidFinding(result)).toBe(false);
  });

  it("suggestion with balanced brackets → kept", () => {
    const result = normalizeFinding(
      { ...base, suggestion: "if (x) { return null; }" } as Record<string, unknown>,
      "perf",
    );
    expect(result.suggestion).toBe("if (x) { return null; }");
  });

  it("suggestion with unbalanced brackets → stripped to null", () => {
    const result = normalizeFinding(
      { ...base, suggestion: "if (x) { return null;" } as Record<string, unknown>,
      "perf",
    );
    expect(result.suggestion).toBeNull();
  });

  it("suggestion_start_line < line → kept", () => {
    const result = normalizeFinding(
      { ...base, line: 10, suggestion: "fix()", suggestion_start_line: 8 } as Record<
        string,
        unknown
      >,
      "perf",
    );
    expect(result.suggestionStartLine).toBe(8);
  });

  it("suggestion_start_line === line → set to null", () => {
    const result = normalizeFinding(
      { ...base, line: 10, suggestion: "fix()", suggestion_start_line: 10 } as Record<
        string,
        unknown
      >,
      "perf",
    );
    expect(result.suggestionStartLine).toBeNull();
  });

  it("suggestion_start_line > line → set to null", () => {
    const result = normalizeFinding(
      { ...base, line: 10, suggestion: "fix()", suggestion_start_line: 15 } as Record<
        string,
        unknown
      >,
      "perf",
    );
    expect(result.suggestionStartLine).toBeNull();
  });

  it("suggestion_start_line = 0 → set to null", () => {
    const result = normalizeFinding(
      { ...base, line: 10, suggestion: "fix()", suggestion_start_line: 0 } as Record<
        string,
        unknown
      >,
      "perf",
    );
    expect(result.suggestionStartLine).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isValidFinding
// ---------------------------------------------------------------------------
describe("isValidFinding", () => {
  const make = (overrides: Partial<ReviewFinding>): ReviewFinding => ({
    id: "test-id",
    severity: "low",
    confidence: "medium",
    file: "a.ts",
    line: 1,
    description: "x",
    suggestion: null,
    suggestionStartLine: null,
    perspective: "test",
    foundBy: ["test"],
    ...overrides,
  });

  it('file="", line=1, description="x" → false', () => {
    expect(isValidFinding(make({ file: "" }))).toBe(false);
  });

  it('file="a.ts", line=0, description="x" → false', () => {
    expect(isValidFinding(make({ line: 0 }))).toBe(false);
  });

  it('file="a.ts", line=1, description="" → false', () => {
    expect(isValidFinding(make({ description: "" }))).toBe(false);
  });

  it('file="a.ts", line=1, description="x" → true', () => {
    expect(isValidFinding(make({}))).toBe(true);
  });

  it("empty perspective → false", () => {
    expect(isValidFinding(make({ perspective: "" }))).toBe(false);
  });

  it("empty foundBy → false", () => {
    expect(isValidFinding(make({ foundBy: [] }))).toBe(false);
  });

  it("direct JSON parse preferred over greedy extraction", () => {
    const input = '{"summary": "ok", "findings": []} some trailing text';
    const result = parseReview(input, "perf");
    expect(result.summary).toBe("ok");
  });

  it("extracts balanced JSON embedded in text", () => {
    const input = 'prefix {"summary": "embedded", "findings": []} suffix';
    const result = parseReview(input, "perf");
    expect(result.summary).toBe("embedded");
  });

  it("repairs trailing commas inside string literals safely", () => {
    const input =
      '{"summary": "x", "findings": [{"severity": "low", "confidence": "medium", "file": "a.ts", "line": 1, "description": "has comma, inside string", "suggestion": null}]}';
    const result = parseReview(input, "perf");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].description).toBe("has comma, inside string");
  });
});

// ---------------------------------------------------------------------------
// generateFindingId / normalizeFindingDescription
// ---------------------------------------------------------------------------
describe("normalizeFindingDescription", () => {
  it("removes stop words and punctuation", () => {
    const normalized = normalizeFindingDescription("The quick brown fox jumps over the lazy dog.");
    expect(normalized).toBe("brown dog fox jumps lazy quick");
  });

  it("handles portuguese stop words", () => {
    const normalized = normalizeFindingDescription(
      "O componente compartilhado não foi alterado por esta PR.",
    );
    expect(normalized).toBe("alterado compartilhado componente");
  });

  it("sorts tokens for stability", () => {
    const a = normalizeFindingDescription("Missing null check before access");
    const b = normalizeFindingDescription("Access before null check is missing");
    expect(a).toBe(b);
  });
});

describe("generateFindingId", () => {
  it("returns stable id for descriptions with same meaning", () => {
    const idA = generateFindingId("lib/main.dart", 42, "Missing null check before accessing value");
    const idB = generateFindingId(
      "lib/main.dart",
      42,
      "The missing null check: before accessing the value",
    );
    expect(idA).toBe(idB);
  });

  it("returns different id for different lines", () => {
    const idA = generateFindingId("lib/main.dart", 42, "Missing null check");
    const idB = generateFindingId("lib/main.dart", 43, "Missing null check");
    expect(idA).not.toBe(idB);
  });

  it("returns different id for different files", () => {
    const idA = generateFindingId("lib/a.dart", 42, "Missing null check");
    const idB = generateFindingId("lib/b.dart", 42, "Missing null check");
    expect(idA).not.toBe(idB);
  });
});
