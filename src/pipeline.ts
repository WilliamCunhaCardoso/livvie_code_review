import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import type { PipelineConfig, Batch, Perspective, ReviewMatrixResult } from "./types.js";
import { fetchDiff, fetchFileContentsParallel } from "./diff.js";
import { filterIgnoredFiles } from "./ignore-patterns.js";
import { countTokens, calculateTokenBudget } from "./tokenizer.js";
import { createBatches } from "./batcher.js";
import { createSemaphore } from "./concurrency.js";
import { createCircuitBreaker } from "./circuit-breaker.js";
import { reviewBatchFromPerspective, type LLMCallConfig } from "./llm-batch.js";
import { consolidateReviews } from "./consolidation.js";
import { postReview } from "./post.js";
import { fetchDismissSignals, applyDismissSignals } from "./review-dismissal.js";

export async function runPipeline(
  config: PipelineConfig,
  perspectives: Perspective[],
): Promise<{ reviewId: number; findingCount: number }> {
  const octokit = new Octokit({ auth: config.githubToken });

  core.startGroup("Stage 1: Fetch");
  const allFiles = await fetchDiff(
    octokit,
    config.owner,
    config.repo,
    config.pullNumber,
    config.maxDiffSize,
  );
  if (allFiles.length === 0) {
    core.info("No files with diffs");
    core.endGroup();
    return { reviewId: 0, findingCount: 0 };
  }

  const { kept: files, ignored } = filterIgnoredFiles(allFiles, config.ignorePatterns);
  if (ignored.length > 0) {
    core.info(
      `Ignored ${ignored.length} generated files: ${ignored.map((f) => f.filename).join(", ")}`,
    );
  }
  if (files.length === 0) {
    core.info("All files ignored");
    core.endGroup();
    return { reviewId: 0, findingCount: 0 };
  }

  core.info(
    `Fetching contents for ${files.length} files (concurrency ${config.fetchConcurrency})...`,
  );
  const fetchResult = await fetchFileContentsParallel(
    octokit,
    config.owner,
    config.repo,
    config.prHeadRef,
    files,
    config.fetchConcurrency,
  );
  const fileContents = fetchResult.contents;
  const failedFiles = fetchResult.failed;
  if (failedFiles.length > 0) {
    core.warning(`Failed to fetch content for ${failedFiles.length} file(s)`);
  }
  core.info(`Fetched ${fileContents.size}/${files.length} file contents`);
  core.endGroup();

  core.startGroup("Stage 2: Batching");
  const maxSystemPromptTokens = Math.max(...perspectives.map((p) => countTokens(p.systemPrompt)));
  const reviewInstructionsTokens = countTokens(config.reviewInstructions);
  const crossFileHunksTokens = Math.min(
    config.crossFileBudgetMax,
    Math.floor(config.contextWindow * (config.crossFileBudgetRatio / 100)),
  );
  const tokenBudget = calculateTokenBudget(
    config.contextWindow,
    config.maxOutputTokens,
    maxSystemPromptTokens,
    reviewInstructionsTokens,
    crossFileHunksTokens,
    config.safetyMargin,
    files.length,
  );
  const batches = createBatches(
    files,
    fileContents,
    tokenBudget,
    config.maxBatches,
    config.diffContextLines,
    failedFiles,
  );
  core.info(`Created ${batches.length} batches for ${files.length} files`);
  for (const batch of batches) {
    core.info(
      `  Batch ${batch.index}: ${batch.files.length} files, ${batch.totalTokenCount} tokens`,
    );
  }
  core.endGroup();

  core.startGroup("Stage 3: Review (matrix)");
  const semaphore = createSemaphore(config.llmConcurrency);
  const circuitBreaker = createCircuitBreaker(config.circuitBreakerThreshold);
  const llmConfig: LLMCallConfig = {
    apiKey: config.llmApiKey,
    baseUrl: config.llmBaseUrl,
    model: config.model,
    fallbackModel: config.fallbackModel,
    maxOutputTokens: config.maxOutputTokens,
    reasoningEffort: config.reasoningEffort,
    reviewInstructions: config.reviewInstructions,
    semaphore,
    circuitBreaker,
    maxRetries: 3,
  };

  const matrixCalls: Array<{
    batch: Batch;
    perspective: Perspective;
    modelOverride?: string;
    temperatureOverride?: number;
  }> = [];
  for (const batch of batches) {
    for (const perspective of perspectives) {
      const overrides = config.agentModelOverrides.get(perspective.id);
      matrixCalls.push({
        batch,
        perspective,
        modelOverride: overrides?.model ?? undefined,
        temperatureOverride: overrides?.temperature ?? undefined,
      });
    }
  }
  core.info(
    `Matrix: ${batches.length} batches × ${perspectives.length} perspectives = ${matrixCalls.length} LLM calls`,
  );

  const results = await Promise.all(
    matrixCalls.map(({ batch, perspective, modelOverride, temperatureOverride }) => {
      core.info(`  Reviewing batch ${batch.index} as ${perspective.name}...`);
      return reviewBatchFromPerspective(
        batch,
        perspective,
        llmConfig,
        modelOverride,
        temperatureOverride,
      );
    }),
  );

  const failedBatches = Array.from(
    new Set(results.filter((r) => r.error).map((r) => r.batchIndex)),
  );
  const unreviewedFiles = batches
    .filter((b) => failedBatches.includes(b.index))
    .flatMap((b) => b.files.map((f) => f.filename));
  for (const filename of failedFiles) {
    if (!unreviewedFiles.includes(filename)) {
      unreviewedFiles.push(filename);
    }
  }

  const matrixResult: ReviewMatrixResult = {
    results,
    rawFindings: results.filter((r) => !r.error).flatMap((r) => r.review.findings),
    failedBatches,
    unreviewedFiles,
    totalCalls: matrixCalls.length,
    successfulCalls: results.filter((r) => !r.error).length,
  };
  core.info(
    `Review complete: ${matrixResult.successfulCalls}/${matrixResult.totalCalls} calls succeeded, ${matrixResult.rawFindings.length} raw findings`,
  );
  core.endGroup();

  core.startGroup("Stage 4: Consolidation");
  let consolidated = consolidateReviews(matrixResult, perspectives, config);
  core.info(
    `Consolidated: ${consolidated.findings.length} findings (after dedup and filters), ${consolidated.stats.high} high, ${consolidated.stats.medium} medium, ${consolidated.stats.low} low`,
  );
  if (consolidated.unreviewedFiles.length > 0) {
    core.warning(`Unreviewed files: ${consolidated.unreviewedFiles.join(", ")}`);
  }
  core.endGroup();

  let dismissedCount = 0;

  if (config.respectAuthorReplies && consolidated.findings.length > 0) {
    core.startGroup("Stage 4.5: Dismiss resolved or replied findings");
    const { signals: dismissSignals, errors: dismissErrors } = await fetchDismissSignals(
      octokit,
      config.owner,
      config.repo,
      config.pullNumber,
      config.prAuthorLogin,
    );
    core.info(
      `Found ${dismissSignals.length} dismiss signals (resolved threads or author replies)`,
    );

    if (dismissErrors.length > 0) {
      core.warning(`Dismissal signal fetch had ${dismissErrors.length} error(s)`);
    }

    if (dismissSignals.length > 0) {
      const { kept, dismissed } = applyDismissSignals(consolidated.findings, dismissSignals);
      dismissedCount = dismissed.length;
      consolidated = {
        ...consolidated,
        findings: kept,
        stats: {
          ...consolidated.stats,
          totalFindings: kept.length,
          high: kept.filter((f) => f.severity === "high").length,
          medium: kept.filter((f) => f.severity === "medium").length,
          low: kept.filter((f) => f.severity === "low").length,
        },
      };
      core.info(`Dismissed ${dismissed.length} findings based on author actions`);
    }
    core.endGroup();
  }

  core.startGroup("Stage 5: Post");
  const perspectiveNameMap = new Map(perspectives.map((p) => [p.id, p.name]));
  const reviewId = await postReview(
    octokit,
    config.owner,
    config.repo,
    config.pullNumber,
    consolidated,
    files,
    config.requestChangesOn,
    config.maxComments,
    perspectiveNameMap,
    config.respectAuthorReplies,
    dismissedCount,
    { submitAs: config.submitAs, selfAuthored: config.selfAuthored },
  );
  core.endGroup();

  return { reviewId, findingCount: consolidated.findings.length };
}
