import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core");
vi.mock("./suggestion.js");
vi.mock("./diff.js");

import {
  formatCommentBody,
  buildReviewBody,
  shouldRetryWithoutInline,
  calculateStartLine,
  postReview,
} from "./post.js";
import { isSuggestionBalanced } from "./suggestion.js";
import { isLineInDiff } from "./diff.js";
import type { ReviewFinding, ConsolidatedReview, DiffFile, PerspectiveSummary } from "./types.js";

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "test-finding-id",
    severity: "medium",
    confidence: "high",
    file: "lib/main.dart",
    line: 10,
    description: "A null check is missing before accessing the value",
    suggestion: null,
    suggestionStartLine: null,
    perspective: "security",
    foundBy: ["security"],
    ...overrides,
  };
}

function makeConsolidated(overrides: Partial<ConsolidatedReview> = {}): ConsolidatedReview {
  return {
    summary: "All good",
    findings: [],
    perspectiveSummaries: [],
    unreviewedFiles: [],
    stats: {
      totalFindings: 0,
      high: 0,
      medium: 0,
      low: 0,
      totalBatches: 1,
      totalPerspectives: 1,
      totalLLMCalls: 1,
      successfulLLMCalls: 1,
      failedBatches: 0,
    },
    ...overrides,
  };
}

function makeDiffFile(filename: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    filename,
    patch: "@@ -1,5 +1,6 @@\n context\n+new line",
    additions: 1,
    deletions: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isSuggestionBalanced).mockReturnValue(true);
  vi.mocked(isLineInDiff).mockReturnValue(true);
});

describe("calculateStartLine", () => {
  it("returns undefined for single-line suggestions", () => {
    const finding = makeFinding({
      line: 10,
      suggestion: "const value = null;",
    });
    expect(calculateStartLine(finding)).toBeUndefined();
  });

  it("computes correct range for multi-line suggestions", () => {
    const finding = makeFinding({
      line: 10,
      suggestion: "line1\nline2\nline3",
    });
    expect(calculateStartLine(finding)).toBe(8);
  });

  it("returns undefined when startLine < 1", () => {
    const finding = makeFinding({
      line: 2,
      suggestion: "line1\nline2\nline3",
    });
    expect(calculateStartLine(finding)).toBeUndefined();
  });

  it("returns undefined when finding has no suggestion", () => {
    const finding = makeFinding({ line: 10, suggestion: null });
    expect(calculateStartLine(finding)).toBeUndefined();
  });
});

describe("shouldRetryWithoutInline", () => {
  it("returns true for 422 with position/line details", () => {
    const error = {
      status: 422,
      response: {
        data: { message: "position is not in the diff" },
      },
    };
    expect(shouldRetryWithoutInline(error)).toBe(true);
  });

  it("returns false for non-422 errors", () => {
    const error = {
      status: 500,
      response: { data: { message: "Internal server error" } },
    };
    expect(shouldRetryWithoutInline(error)).toBe(false);
  });

  it("returns false for 422 without diff-related details", () => {
    const error = {
      status: 422,
      response: {
        data: { message: "Validation failed" },
      },
    };
    expect(shouldRetryWithoutInline(error)).toBe(false);
  });

  it("returns true for 422 with line keyword in message", () => {
    const error = {
      status: 422,
      message: "line not found in diff",
    };
    expect(shouldRetryWithoutInline(error)).toBe(true);
  });

  it("returns true for 422 with side keyword", () => {
    const error = {
      status: 422,
      response: {
        data: { message: "invalid side parameter" },
      },
    };
    expect(shouldRetryWithoutInline(error)).toBe(true);
  });
});

describe("formatCommentBody", () => {
  it("renders perspective name from perspectiveNameMap", () => {
    const finding = makeFinding({ foundBy: ["security"] });
    const nameMap = new Map([["security", "Security Expert"]]);
    const body = formatCommentBody(finding, nameMap);
    expect(body).toContain("Found by: **Security Expert**");
  });

  it("falls back to perspectiveId when name not in map", () => {
    const finding = makeFinding({ foundBy: ["unknown-id"] });
    const nameMap = new Map<string, string>();
    const body = formatCommentBody(finding, nameMap);
    expect(body).toContain("Found by: **unknown-id**");
  });

  it("renders multi-perspective attribution (foundBy with 2+ ids)", () => {
    const finding = makeFinding({
      foundBy: ["security", "performance"],
    });
    const nameMap = new Map([
      ["security", "Security Expert"],
      ["performance", "Performance Guru"],
    ]);
    const body = formatCommentBody(finding, nameMap);
    expect(body).toContain("Found by: Security Expert, Performance Guru");
    expect(body).not.toContain("**Security Expert, Performance Guru**");
  });

  it("renders severity badge and confidence icon", () => {
    const finding = makeFinding({
      id: "finding-xyz",
      severity: "high",
      confidence: "low",
    });
    const nameMap = new Map([["security", "Security Expert"]]);
    const body = formatCommentBody(finding, nameMap);
    expect(body).toContain("🔴");
    expect(body).toContain("❓");
    expect(body).toContain("HIGH");
    expect(body).toContain("<!-- livvie:finding-id:finding-xyz -->");
  });

  it("renders suggestion as suggestion code block when balanced", () => {
    const finding = makeFinding({
      suggestion: "const safe = value ?? fallback;",
    });
    vi.mocked(isSuggestionBalanced).mockReturnValue(true);
    const nameMap = new Map([["security", "Security Expert"]]);
    const body = formatCommentBody(finding, nameMap);
    expect(body).toContain("```suggestion");
    expect(body).toContain("const safe = value ?? fallback;");
  });

  it("renders suggestion as plain code block when unbalanced", () => {
    const finding = makeFinding({
      suggestion: "const obj = {",
    });
    vi.mocked(isSuggestionBalanced).mockReturnValue(false);
    const nameMap = new Map([["security", "Security Expert"]]);
    const body = formatCommentBody(finding, nameMap);
    expect(body).toContain("```\nconst obj = {");
    expect(body).not.toContain("```suggestion");
  });
});

describe("buildReviewBody", () => {
  it("contains Agent Breakdown table with perspective names", () => {
    const perspectiveSummaries: PerspectiveSummary[] = [
      {
        perspectiveId: "security",
        perspectiveName: "Security Expert",
        findingCount: 2,
        highCount: 1,
        mediumCount: 1,
        lowCount: 0,
        summary: "Found issues",
      },
      {
        perspectiveId: "performance",
        perspectiveName: "Performance Guru",
        findingCount: 1,
        highCount: 0,
        mediumCount: 0,
        lowCount: 1,
        summary: "Minor issues",
      },
    ];
    const consolidated = makeConsolidated({
      perspectiveSummaries,
      stats: {
        totalFindings: 3,
        high: 1,
        medium: 1,
        low: 1,
        totalBatches: 1,
        totalPerspectives: 2,
        totalLLMCalls: 2,
        successfulLLMCalls: 2,
        failedBatches: 0,
      },
    });
    const nameMap = new Map([
      ["security", "Security Expert"],
      ["performance", "Performance Guru"],
    ]);
    const body = buildReviewBody(consolidated, new Set(), nameMap);
    expect(body).toContain("### 🏷️ Agent Breakdown");
    expect(body).toContain("Security Expert");
    expect(body).toContain("Performance Guru");
    expect(body).toContain("| Perspective | High | Medium | Low | Total |");
  });

  it("contains severity stats", () => {
    const consolidated = makeConsolidated({
      stats: {
        totalFindings: 2,
        high: 1,
        medium: 1,
        low: 0,
        totalBatches: 1,
        totalPerspectives: 1,
        totalLLMCalls: 1,
        successfulLLMCalls: 1,
        failedBatches: 0,
      },
    });
    const nameMap = new Map([["security", "Security Expert"]]);
    const body = buildReviewBody(consolidated, new Set(), nameMap);
    expect(body).toContain("🔴 **1 High**");
    expect(body).toContain("🟡 **1 Medium**");
    expect(body).not.toContain("Low");
  });

  it("shows no issues message when no findings", () => {
    const consolidated = makeConsolidated();
    const nameMap = new Map<string, string>();
    const body = buildReviewBody(consolidated, new Set(), nameMap);
    expect(body).toContain("✅ **No issues found**");
  });

  it("includes reply instructions when respectAuthorReplies is true and findings exist", () => {
    const consolidated = makeConsolidated({
      findings: [makeFinding()],
      stats: { ...makeConsolidated().stats, totalFindings: 1 },
    });
    const nameMap = new Map<string, string>();
    const body = buildReviewBody(consolidated, new Set([makeFinding()]), nameMap, true, 0);
    expect(body).toContain("Disagree with a finding?");
  });

  it("shows dismissed findings count", () => {
    const consolidated = makeConsolidated({
      findings: [makeFinding()],
      stats: { ...makeConsolidated().stats, totalFindings: 1 },
    });
    const nameMap = new Map<string, string>();
    const body = buildReviewBody(consolidated, new Set([makeFinding()]), nameMap, true, 2);
    expect(body).toContain("2 findings were dismissed");
  });
});

describe("postReview", () => {
  function makeOctokit() {
    return {
      rest: {
        pulls: {
          createReview: vi.fn().mockResolvedValue({ data: { id: 42 } }),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
          dismissReview: vi.fn(),
          listCommentsForReview: vi.fn().mockResolvedValue({ data: [] }),
          deleteReviewComment: vi.fn(),
          updateReview: vi.fn(),
        },
      },
      paginate: vi.fn().mockResolvedValue([]),
    } as unknown as import("@octokit/rest").Octokit;
  }

  it("posts review and returns reviewId", async () => {
    const octokit = makeOctokit();
    const finding = makeFinding({ severity: "low", foundBy: ["generalist"] });
    const consolidated = makeConsolidated({
      findings: [finding],
      stats: {
        totalFindings: 1,
        high: 0,
        medium: 0,
        low: 1,
        totalBatches: 1,
        totalPerspectives: 1,
        totalLLMCalls: 1,
        successfulLLMCalls: 1,
        failedBatches: 0,
      },
    });
    const files = [makeDiffFile("lib/main.dart")];
    const nameMap = new Map([["generalist", "General Reviewer"]]);

    const reviewId = await postReview(
      octokit,
      "owner",
      "repo",
      1,
      consolidated,
      files,
      new Set(["high"]),
      10,
      nameMap,
    );

    expect(reviewId).toBe(42);
    expect(
      (octokit as unknown as { rest: { pulls: { createReview: ReturnType<typeof vi.fn> } } }).rest
        .pulls.createReview,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        pull_number: 1,
        event: "APPROVE",
      }),
    );
  });

  it("requests changes when findings match a severity in requestChangesOn", async () => {
    const octokit = makeOctokit();
    const finding = makeFinding({ severity: "high", foundBy: ["security"] });
    const consolidated = makeConsolidated({
      findings: [finding],
    });
    const files = [makeDiffFile("lib/main.dart")];
    const nameMap = new Map([["security", "Security Expert"]]);

    await postReview(
      octokit,
      "owner",
      "repo",
      1,
      consolidated,
      files,
      new Set(["high"]),
      10,
      nameMap,
    );

    expect(
      (octokit as unknown as { rest: { pulls: { createReview: ReturnType<typeof vi.fn> } } }).rest
        .pulls.createReview,
    ).toHaveBeenCalledWith(expect.objectContaining({ event: "REQUEST_CHANGES" }));
  });

  it("approves when findings do not match requestChangesOn severities", async () => {
    const octokit = makeOctokit();
    const finding = makeFinding({ severity: "low", foundBy: ["generalist"] });
    const consolidated = makeConsolidated({
      findings: [finding],
      stats: {
        totalFindings: 1,
        high: 0,
        medium: 0,
        low: 1,
        totalBatches: 1,
        totalPerspectives: 1,
        totalLLMCalls: 1,
        successfulLLMCalls: 1,
        failedBatches: 0,
      },
    });
    const files = [makeDiffFile("lib/main.dart")];
    const nameMap = new Map([["generalist", "General Reviewer"]]);

    await postReview(
      octokit,
      "owner",
      "repo",
      1,
      consolidated,
      files,
      new Set(["high"]),
      10,
      nameMap,
    );

    expect(
      (octokit as unknown as { rest: { pulls: { createReview: ReturnType<typeof vi.fn> } } }).rest
        .pulls.createReview,
    ).toHaveBeenCalledWith(expect.objectContaining({ event: "APPROVE" }));
  });

  it("approves when no findings even if requestChangesOn contains severities", async () => {
    const octokit = makeOctokit();
    const consolidated = makeConsolidated();
    const files = [makeDiffFile("lib/main.dart")];
    const nameMap = new Map<string, string>();

    await postReview(
      octokit,
      "owner",
      "repo",
      1,
      consolidated,
      files,
      new Set(["low", "medium", "high"]),
      10,
      nameMap,
    );

    expect(
      (octokit as unknown as { rest: { pulls: { createReview: ReturnType<typeof vi.fn> } } }).rest
        .pulls.createReview,
    ).toHaveBeenCalledWith(expect.objectContaining({ event: "APPROVE" }));
  });
});
