import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core");
vi.mock("@octokit/rest", () => {
  return {
    Octokit: class MockOctokit {
      constructor() {}
    },
  };
});
vi.mock("./diff.js");
vi.mock("./ignore-patterns.js");
vi.mock("./tokenizer.js");
vi.mock("./batcher.js");
vi.mock("./concurrency.js");
vi.mock("./circuit-breaker.js");
vi.mock("./llm-batch.js");
vi.mock("./consolidation.js");
vi.mock("./post.js");

import { runPipeline } from "./pipeline.js";
import { fetchDiff, fetchFileContentsParallel } from "./diff.js";
import { filterIgnoredFiles } from "./ignore-patterns.js";
import { countTokens, calculateTokenBudget } from "./tokenizer.js";
import { createBatches } from "./batcher.js";
import { createSemaphore, mapWithConcurrency } from "./concurrency.js";
import { createCircuitBreaker } from "./circuit-breaker.js";
import { reviewBatchFromPerspective } from "./llm-batch.js";
import { consolidateReviews } from "./consolidation.js";
import { postReview } from "./post.js";
import type {
  PipelineConfig,
  Perspective,
  DiffFile,
  Batch,
  BatchReviewResult,
  ConsolidatedReview,
  TokenBudget,
  Semaphore,
} from "./types.js";

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    githubToken: "test-token",
    owner: "test-owner",
    repo: "test-repo",
    pullNumber: 42,
    prHeadRef: "feature",
    prBaseRef: "main",
    prAuthorLogin: "test-author",
    llmApiKey: "test-api-key",
    llmBaseUrl: "https://api.test.com",
    model: "primary-model",
    fallbackModel: "fallback-model",
    maxOutputTokens: 4096,
    reasoningEffort: "medium",
    maxDiffSize: 100000,
    maxBatches: 10,
    contextWindow: 128000,
    ignorePatterns: [],
    hotfixLabels: [],
    hotfixKeywords: [],
    agentsDir: ".agents",
    agentModelOverrides: new Map(),
    reviewInstructions: "Review this code carefully",
    includeSeverities: new Set(["low", "medium", "high"]),
    includeConfidences: new Set(["low", "medium", "high"]),
    requestChangesOn: new Set(["high"]),
    maxComments: 10,
    fetchConcurrency: 5,
    llmConcurrency: 3,
    safetyMargin: 500,
    crossFileBudgetRatio: 5,
    crossFileBudgetMax: 2000,
    circuitBreakerThreshold: 3,
    ...overrides,
  };
}

function makePerspective(id: string, name?: string): Perspective {
  return {
    id,
    name: name ?? `${id} Reviewer`,
    systemPrompt: `System prompt for ${id}`,
    focus: id,
  };
}

function makeDiffFile(filename: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    filename,
    patch: "@@ -1,3 +1,4 @@\n+new line",
    additions: 1,
    deletions: 0,
    ...overrides,
  };
}

function makeBatch(index: number, filenames: string[]): Batch {
  return {
    index,
    files: filenames.map((name) => ({
      filename: name,
      patch: "@@ -1,3 +1,4 @@\n+new line",
      additions: 1,
      deletions: 0,
      content: `1: existing\n2: → new line`,
      tokenCount: 50,
      truncated: false,
      directory: ".",
    })),
    tokenCount: 50 * filenames.length,
    crossFileContext: "",
    totalTokenCount: 50 * filenames.length + 100,
  };
}

function makeBatchResult(
  batchIndex: number,
  perspectiveId: string,
  perspectiveName: string,
  overrides: Partial<BatchReviewResult> = {},
): BatchReviewResult {
  return {
    batchIndex,
    perspectiveId,
    perspectiveName,
    review: { summary: "Looks good", findings: [] },
    modelUsed: "primary-model",
    latencyMs: 100,
    usedFallback: false,
    ...overrides,
  };
}

function makeSemaphore(): Semaphore {
  return {
    acquire: vi.fn<() => Promise<() => void>>().mockResolvedValue(() => {}),
    available: 10,
    waiting: 0,
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

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(createSemaphore).mockReturnValue(makeSemaphore());
  vi.mocked(createCircuitBreaker).mockReturnValue({
    check: vi.fn().mockReturnValue(false),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      state: "closed",
      consecutiveFailures: 0,
      openedAt: null,
      threshold: 3,
    }),
  });
  vi.mocked(countTokens).mockReturnValue(100);
  vi.mocked(calculateTokenBudget).mockReturnValue({
    contextWindow: 128000,
    maxOutput: 4096,
    systemPromptTokens: 100,
    reviewInstructionsTokens: 50,
    crossFileHunksTokens: 100,
    safetyMargin: 0.15,
    fileBudget: 100000,
  } satisfies TokenBudget);
  vi.mocked(fetchFileContentsParallel).mockResolvedValue({ contents: new Map(), failed: [] });
  vi.mocked(mapWithConcurrency).mockImplementation(async (items, mapper) => {
    const results = [];
    for (let index = 0; index < items.length; index++) {
      results.push(await mapper(items[index], index));
    }
    return results;
  });
});

describe("runPipeline", () => {
  it("returns { reviewId: 0, findingCount: 0 } when diff has no files", async () => {
    const config = makeConfig();
    const perspectives = [makePerspective("generalist")];

    vi.mocked(fetchDiff).mockResolvedValue([]);

    const result = await runPipeline(config, perspectives);

    expect(result).toEqual({ reviewId: 0, findingCount: 0 });
    expect(filterIgnoredFiles).not.toHaveBeenCalled();
    expect(createBatches).not.toHaveBeenCalled();
    expect(reviewBatchFromPerspective).not.toHaveBeenCalled();
  });

  it("returns { reviewId: 0, findingCount: 0 } when all files are ignored", async () => {
    const config = makeConfig();
    const perspectives = [makePerspective("generalist")];
    const allFiles = [makeDiffFile("generated.dart")];

    vi.mocked(fetchDiff).mockResolvedValue(allFiles);
    vi.mocked(filterIgnoredFiles).mockReturnValue({
      kept: [],
      ignored: allFiles,
    });

    const result = await runPipeline(config, perspectives);

    expect(result).toEqual({ reviewId: 0, findingCount: 0 });
    expect(createBatches).not.toHaveBeenCalled();
    expect(reviewBatchFromPerspective).not.toHaveBeenCalled();
  });

  it("constructs correct matrix: N batches × M perspectives = N*M LLM calls", async () => {
    const config = makeConfig();
    const perspectives = [
      makePerspective("security"),
      makePerspective("performance"),
      makePerspective("generalist"),
    ];
    const keptFiles = [makeDiffFile("lib/a.dart"), makeDiffFile("lib/b.dart")];
    const batches = [makeBatch(0, ["lib/a.dart"]), makeBatch(1, ["lib/b.dart"])];
    const consolidated = makeConsolidated();

    vi.mocked(fetchDiff).mockResolvedValue(keptFiles);
    vi.mocked(filterIgnoredFiles).mockReturnValue({ kept: keptFiles, ignored: [] });
    vi.mocked(createBatches).mockReturnValue(batches);
    vi.mocked(reviewBatchFromPerspective).mockResolvedValue(
      makeBatchResult(0, "generalist", "Generalist Reviewer"),
    );
    vi.mocked(consolidateReviews).mockReturnValue(consolidated);
    vi.mocked(postReview).mockResolvedValue(100);

    await runPipeline(config, perspectives);

    expect(reviewBatchFromPerspective).toHaveBeenCalledTimes(6);
  });

  it("passes modelOverride from agentModelOverrides to reviewBatchFromPerspective", async () => {
    const agentModelOverrides = new Map([
      ["security", { model: "security-specialist-v2", temperature: 0.2 }],
    ]);
    const config = makeConfig({ agentModelOverrides });
    const perspectives = [makePerspective("security")];
    const keptFiles = [makeDiffFile("lib/main.dart")];
    const batches = [makeBatch(0, ["lib/main.dart"])];
    const consolidated = makeConsolidated();

    vi.mocked(fetchDiff).mockResolvedValue(keptFiles);
    vi.mocked(filterIgnoredFiles).mockReturnValue({ kept: keptFiles, ignored: [] });
    vi.mocked(createBatches).mockReturnValue(batches);
    vi.mocked(reviewBatchFromPerspective).mockResolvedValue(
      makeBatchResult(0, "security", "Security Reviewer"),
    );
    vi.mocked(consolidateReviews).mockReturnValue(consolidated);
    vi.mocked(postReview).mockResolvedValue(100);

    await runPipeline(config, perspectives);

    expect(reviewBatchFromPerspective).toHaveBeenCalledWith(
      batches[0],
      perspectives[0],
      expect.objectContaining({ model: "primary-model" }),
      "security-specialist-v2",
      0.2,
    );
  });

  it("builds perspectiveNameMap from perspectives and passes to postReview", async () => {
    const config = makeConfig();
    const perspectives = [
      makePerspective("security", "Security Expert"),
      makePerspective("performance", "Performance Guru"),
    ];
    const keptFiles = [makeDiffFile("lib/main.dart")];
    const batches = [makeBatch(0, ["lib/main.dart"])];
    const consolidated = makeConsolidated();

    vi.mocked(fetchDiff).mockResolvedValue(keptFiles);
    vi.mocked(filterIgnoredFiles).mockReturnValue({ kept: keptFiles, ignored: [] });
    vi.mocked(createBatches).mockReturnValue(batches);
    vi.mocked(reviewBatchFromPerspective).mockResolvedValue(
      makeBatchResult(0, "security", "Security Expert"),
    );
    vi.mocked(consolidateReviews).mockReturnValue(consolidated);
    vi.mocked(postReview).mockResolvedValue(100);

    await runPipeline(config, perspectives);

    const expectedMap = new Map([
      ["security", "Security Expert"],
      ["performance", "Performance Guru"],
    ]);
    expect(postReview).toHaveBeenCalledWith(
      expect.anything(),
      config.owner,
      config.repo,
      config.pullNumber,
      consolidated,
      keptFiles,
      config.requestChangesOn,
      config.maxComments,
      expectedMap,
      config.respectAuthorReplies,
      0,
    );
  });

  it("detects failed batches and collects unreviewed files", async () => {
    const config = makeConfig();
    const perspectives = [makePerspective("generalist")];
    const keptFiles = [makeDiffFile("lib/ok.dart"), makeDiffFile("lib/failed.dart")];
    const batches = [makeBatch(0, ["lib/ok.dart"]), makeBatch(1, ["lib/failed.dart"])];
    const consolidated = makeConsolidated({
      unreviewedFiles: ["lib/failed.dart"],
    });

    vi.mocked(fetchDiff).mockResolvedValue(keptFiles);
    vi.mocked(filterIgnoredFiles).mockReturnValue({ kept: keptFiles, ignored: [] });
    vi.mocked(createBatches).mockReturnValue(batches);

    let callIndex = 0;
    vi.mocked(reviewBatchFromPerspective).mockImplementation(async (_batch, _perspective) => {
      if (callIndex === 0) {
        callIndex++;
        return makeBatchResult(0, "generalist", "Generalist Reviewer");
      }
      return makeBatchResult(1, "generalist", "Generalist Reviewer", {
        error: "LLM API timeout",
        review: { summary: "", findings: [] },
      });
    });

    vi.mocked(consolidateReviews).mockReturnValue(consolidated);
    vi.mocked(postReview).mockResolvedValue(100);

    await runPipeline(config, perspectives);

    expect(consolidateReviews).toHaveBeenCalledWith(
      expect.objectContaining({
        failedBatches: [1],
        unreviewedFiles: ["lib/failed.dart"],
      }),
      perspectives,
      config,
    );
  });

  it("passes perspectives to consolidateReviews", async () => {
    const config = makeConfig();
    const perspectives = [
      makePerspective("security", "Security Expert"),
      makePerspective("performance", "Performance Guru"),
    ];
    const keptFiles = [makeDiffFile("lib/main.dart")];
    const batches = [makeBatch(0, ["lib/main.dart"])];
    const consolidated = makeConsolidated();

    vi.mocked(fetchDiff).mockResolvedValue(keptFiles);
    vi.mocked(filterIgnoredFiles).mockReturnValue({ kept: keptFiles, ignored: [] });
    vi.mocked(createBatches).mockReturnValue(batches);
    vi.mocked(reviewBatchFromPerspective).mockResolvedValue(
      makeBatchResult(0, "security", "Security Expert"),
    );
    vi.mocked(consolidateReviews).mockReturnValue(consolidated);
    vi.mocked(postReview).mockResolvedValue(100);

    await runPipeline(config, perspectives);

    expect(consolidateReviews).toHaveBeenCalledWith(
      expect.objectContaining({
        results: expect.any(Array),
        rawFindings: expect.any(Array),
        failedBatches: expect.any(Array),
        unreviewedFiles: expect.any(Array),
        totalCalls: 2,
        successfulCalls: expect.any(Number),
      }),
      perspectives,
      config,
    );
  });
});
