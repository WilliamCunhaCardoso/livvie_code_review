import * as core from "@actions/core";
import * as fs from "fs";
import { Octokit } from "@octokit/rest";
import { runPipeline } from "./pipeline.js";
import type { PipelineConfig } from "./types.js";
import { parseIgnorePatterns } from "./ignore-patterns.js";
import { loadAgents } from "./agent-loader.js";
import { parseHotfixList, buildScopeHint } from "./scope-hints.js";

function parsePositiveInt(value: string, name: string, defaultValue: number): number {
  const parsed = parseInt(value || String(defaultValue), 10);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${name}: "${value}". Must be a non-negative integer.`);
  }
  return parsed;
}

function parseStrictlyPositiveInt(value: string, name: string, defaultValue: number): number {
  const parsed = parseInt(value || String(defaultValue), 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${name}: "${value}". Must be a positive integer.`);
  }
  return parsed;
}

function parseLevelList(value: string, name: string): Set<"low" | "medium" | "high"> {
  const defaultSet = new Set<"low" | "medium" | "high">(["low", "medium", "high"]);
  const trimmed = (value || "").trim();
  if (!trimmed) return defaultSet;

  const parts = trimmed
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);

  const valid: Set<"low" | "medium" | "high"> = new Set();
  for (const part of parts) {
    if (part === "low" || part === "medium" || part === "high") {
      valid.add(part);
    } else {
      throw new Error(`Invalid value for ${name}: "${part}". Must be one of: low, medium, high.`);
    }
  }

  if (valid.size === 0) return defaultSet;
  return valid;
}

function validateUrl(value: string, name: string): void {
  if (!value || !value.trim()) {
    throw new Error(`Invalid value for ${name}: empty string`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error(`Invalid value for ${name}: must use HTTPS protocol`);
    }
  } catch {
    throw new Error(`Invalid value for ${name}: "${value}". Must be a valid HTTPS URL`);
  }
}

async function loadReviewInstructions(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
): Promise<string> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref,
    });

    if ("content" in response.data && response.data.content) {
      return Buffer.from(response.data.content, "base64").toString("utf8");
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.info(`No review instructions file found at ${filePath}: ${message}`);
  }

  return "";
}

async function run(): Promise<void> {
  try {
    const context = JSON.parse(
      process.env.GITHUB_EVENT_PATH ? fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8") : "{}",
    );
    const pullNumber = context.pull_request?.number;
    if (!pullNumber) {
      core.info("No pull request in event, skipping");
      return;
    }

    const owner = context.repository?.owner?.login;
    const repo = context.repository?.name;
    if (!owner || !repo) {
      throw new Error("Could not determine repository owner/name");
    }

    const githubToken = core.getInput("github-token", { required: true });
    core.setSecret(githubToken);

    const llmApiKey = core.getInput("llm-api-key", { required: true });
    core.setSecret(llmApiKey);

    const reviewInstructionsFile =
      core.getInput("review-instructions-file") || ".github/code-reviewer.md";
    const prBaseRef = context.pull_request?.base?.ref ?? "main";

    const agentsDir = core.getInput("agents-dir") || ".github/livvie_code_review_agents";

    const verbose = core.getInput("verbose") === "true";
    process.env.LIVVIE_VERBOSE = verbose ? "1" : "";

    const octokit = new Octokit({ auth: githubToken });
    const reviewInstructions = await loadReviewInstructions(
      octokit,
      owner,
      repo,
      prBaseRef,
      reviewInstructionsFile,
    );

    const prContext = {
      title: context.pull_request?.title ?? "",
      body: context.pull_request?.body ?? "",
      labels: Array.isArray(context.pull_request?.labels)
        ? context.pull_request.labels
            .map((label: { name?: string }) => label.name ?? "")
            .filter((name: string) => name.length > 0)
        : [],
    };

    const hotfixLabels = parseHotfixList(
      core.getInput("hotfix-labels") || "hotfix,urgent,critical,bugfix",
    );
    const hotfixKeywords = parseHotfixList(
      core.getInput("hotfix-keywords") || "hotfix,urgent,critical,bug fix",
    );
    const scopeHint = buildScopeHint(prContext, hotfixLabels, hotfixKeywords);

    const combinedReviewInstructions = scopeHint
      ? `${reviewInstructions.trim()}\n\n${scopeHint}`.trim()
      : reviewInstructions;

    const { perspectives, agentModelOverrides } = await loadAgents(
      octokit,
      owner,
      repo,
      prBaseRef,
      agentsDir,
    );

    const llmBaseUrl = core.getInput("llm-base-url", { required: true });
    validateUrl(llmBaseUrl, "llm-base-url");

    const config: PipelineConfig = {
      githubToken,
      owner,
      repo,
      pullNumber,
      prHeadRef: context.pull_request?.head?.ref ?? "",
      prBaseRef,
      llmApiKey,
      llmBaseUrl,
      model: core.getInput("model", { required: true }),
      fallbackModel: core.getInput("fallback-model") || "",
      maxOutputTokens: parseStrictlyPositiveInt(
        core.getInput("max-output-tokens"),
        "max-output-tokens",
        16000,
      ),
      reasoningEffort: core.getInput("reasoning-effort") || "none",
      maxDiffSize: parseStrictlyPositiveInt(core.getInput("max-diff-size"), "max-diff-size", 50000),
      maxBatches: parsePositiveInt(core.getInput("max-batches"), "max-batches", 0),
      contextWindow: parseStrictlyPositiveInt(
        core.getInput("context-window"),
        "context-window",
        128000,
      ),
      ignorePatterns: parseIgnorePatterns(
        core.getInput("ignore-patterns") || "build/**,dist/**,node_modules/**",
      ),
      agentsDir,
      agentModelOverrides,
      reviewInstructions: combinedReviewInstructions,
      includeSeverities: parseLevelList(core.getInput("include-severities"), "include-severities"),
      includeConfidences: parseLevelList(
        core.getInput("include-confidences"),
        "include-confidences",
      ),
      requestChangesOn: parseLevelList(core.getInput("request-changes-on"), "request-changes-on"),
      maxComments: parsePositiveInt(core.getInput("max-comments"), "max-comments", 25),
      respectAuthorReplies: core.getInput("respect-author-replies") === "true",
      fetchConcurrency: 5,
      llmConcurrency: 3,
      safetyMargin: parsePositiveInt(core.getInput("safety-margin"), "safety-margin", 500),
      crossFileBudgetRatio: parsePositiveInt(
        core.getInput("cross-file-budget-ratio"),
        "cross-file-budget-ratio",
        5,
      ),
      crossFileBudgetMax: parsePositiveInt(
        core.getInput("cross-file-budget-max"),
        "cross-file-budget-max",
        2000,
      ),
      circuitBreakerThreshold: parsePositiveInt(
        core.getInput("circuit-breaker-threshold"),
        "circuit-breaker-threshold",
        3,
      ),
      hotfixLabels,
      hotfixKeywords,
    };

    core.info(`Reviewing PR #${pullNumber} in ${owner}/${repo}`);
    core.info(`Agents: ${perspectives.map((p) => p.name).join(", ")}`);
    core.info(`Max batches: ${config.maxBatches || "unlimited"}`);

    const { reviewId, findingCount } = await runPipeline(config, perspectives);
    if (reviewId > 0) {
      core.setOutput("review-id", String(reviewId));
      core.setOutput("finding-count", String(findingCount));
      core.info(`Posted review #${reviewId}`);
    }
    core.info("Done");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

run();
