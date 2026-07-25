import * as core from "@actions/core";
import type {
  Batch,
  Perspective,
  BatchReviewResult,
  Semaphore,
  StructuredReview,
} from "./types.js";
import {
  createCircuitBreaker,
  calculateBackoff,
  parseRetryAfter,
  sleep,
} from "./circuit-breaker.js";
import { parseReview } from "./llm.js";

const LLM_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_TEMPERATURE = 0.1;
const MIN_CONTENT_LENGTH = 20;
const SHORT_CONTENT_WARNING_LENGTH = 100;

interface LLMChoice {
  message?: {
    content?: string;
    reasoning_content?: string;
  };
  finish_reason?: string;
}

interface LLMResponseData {
  choices?: LLMChoice[];
}

export interface LLMCallConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  maxOutputTokens: number;
  reasoningEffort: string;
  reviewInstructions: string;
  semaphore: Semaphore;
  circuitBreaker: ReturnType<typeof createCircuitBreaker>;
  maxRetries: number;
}

export async function reviewBatchFromPerspective(
  batch: Batch,
  perspective: Perspective,
  config: LLMCallConfig,
  modelOverride?: string,
  temperatureOverride?: number,
): Promise<BatchReviewResult> {
  const skipPrimary = config.circuitBreaker.check();
  const release = await config.semaphore.acquire();
  const startTime = Date.now();

  try {
    const userContent = buildBatchUserMessage(batch, config.reviewInstructions);
    let review: StructuredReview | null = null;
    let modelUsed = "";
    let usedFallback = false;
    let error: string | undefined;

    if (!skipPrimary) {
      try {
        const result = await callLLMWithRetry(
          config.apiKey,
          config.baseUrl,
          modelOverride ?? config.model,
          perspective.systemPrompt,
          userContent,
          config.maxOutputTokens,
          config.reasoningEffort,
          config.maxRetries,
          temperatureOverride,
        );
        config.circuitBreaker.recordSuccess();
        review = parseReview(result.content, perspective.id);
        modelUsed = result.modelUsed;
        core.info(
          `Batch ${batch.index} / ${perspective.name}: primary model succeeded (${review.findings.length} findings)`,
        );
      } catch (primaryError) {
        config.circuitBreaker.recordFailure();
        const msg = primaryError instanceof Error ? primaryError.message : String(primaryError);
        core.warning(`Batch ${batch.index} / ${perspective.name}: primary model failed — ${msg}`);
        error = `Primary model: ${msg}`;
      }
    } else {
      core.info(
        `Batch ${batch.index} / ${perspective.name}: circuit breaker open, skipping primary model`,
      );
      error = "Circuit breaker open — primary model skipped";
    }

    if (review === null && config.fallbackModel) {
      try {
        const result = await callLLMWithRetry(
          config.apiKey,
          config.baseUrl,
          config.fallbackModel,
          perspective.systemPrompt,
          userContent,
          config.maxOutputTokens,
          "none",
          config.maxRetries,
          temperatureOverride,
        );
        review = parseReview(result.content, perspective.id);
        modelUsed = result.modelUsed;
        usedFallback = true;
        core.info(
          `Batch ${batch.index} / ${perspective.name}: fallback model succeeded (${review.findings.length} findings)`,
        );
      } catch (fallbackError) {
        const msg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        core.warning(
          `Batch ${batch.index} / ${perspective.name}: fallback model also failed — ${msg}`,
        );
        error = error ? `${error}; Fallback model: ${msg}` : `Fallback model: ${msg}`;
      }
    }

    const latencyMs = Date.now() - startTime;

    if (review === null) {
      return {
        batchIndex: batch.index,
        perspectiveId: perspective.id,
        perspectiveName: perspective.name,
        review: { summary: "", findings: [] },
        modelUsed: modelUsed || (skipPrimary ? config.fallbackModel : config.model),
        latencyMs,
        usedFallback: false,
        error,
      };
    }

    return {
      batchIndex: batch.index,
      perspectiveId: perspective.id,
      perspectiveName: perspective.name,
      review,
      modelUsed,
      latencyMs,
      usedFallback,
      error,
    };
  } finally {
    release();
  }
}

export function buildBatchUserMessage(batch: Batch, reviewInstructions: string): string {
  const parts: string[] = [];

  if (reviewInstructions.trim()) {
    parts.push("## Project-specific review rules");
    parts.push(reviewInstructions);
    parts.push("");
  }

  if (batch.crossFileContext.trim()) {
    parts.push("## Cross-file context (context only — do NOT review these files)");
    parts.push(batch.crossFileContext);
    parts.push("");
  }

  parts.push("## Files to review");
  parts.push("");

  for (const file of batch.files) {
    parts.push(`### ${file.filename} (${file.additions}+, ${file.deletions}-)`);
    if (file.truncated) {
      parts.push(
        "Windowed file with line numbers (context around changed lines). Lines marked with \u2192 were changed in this PR.",
      );
    } else {
      parts.push("Full file with line numbers. Lines marked with \u2192 were changed in this PR.");
    }
    parts.push("");
    parts.push("```");
    parts.push(file.content);
    parts.push("```");
    parts.push("");
  }

  parts.push("Return your review as a JSON object. Only return JSON, no markdown.");

  return parts.join("\n");
}

export async function callLLMWithRetry(
  apiKey: string,
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  maxOutputTokens: number,
  reasoningEffort: string,
  maxRetries: number,
  temperatureOverride?: number,
): Promise<{ content: string; modelUsed: string }> {
  const requestBody: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: temperatureOverride ?? DEFAULT_TEMPERATURE,
    max_tokens: maxOutputTokens,
    response_format: { type: "json_object" },
  };

  if (reasoningEffort !== "none") {
    requestBody.reasoning = { effort: reasoningEffort };
  }

  const body = JSON.stringify(requestBody);
  let lastError: Error | null = null;
  let lastResponseStatus: number | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": "https://github.com/4itworks/livvie_code_review",
            "X-Title": "livvie-code-review",
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      lastResponseStatus = response.status;

      if (!response.ok) {
        const errorText = await response.text();
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        if (retryAfter !== null && attempt < maxRetries) {
          core.warning(
            `LLM API ${response.status} (attempt ${attempt}/${maxRetries}). Retry-After: ${retryAfter}ms. Waiting...`,
          );
          await sleep(retryAfter);
          continue;
        }
        const sanitizedError = errorText
          .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
          .slice(0, 500);
        const retryableStatus = isRetryableHttpStatus(response.status);
        throw new Error(
          `LLM API error ${response.status}${retryableStatus ? " (retryable)" : " (non-retryable)"}: ${sanitizedError}`,
        );
      }

      const responseText = (await response.text()).trim();

      if (responseText.length === 0) {
        throw new Error(`LLM returned empty response body (status ${response.status})`);
      }

      let data: LLMResponseData | undefined;
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error(
          `LLM returned invalid JSON response (${responseText.length} chars). ` +
            `Preview: ${responseText.slice(0, 200)}`,
        );
      }

      const choices = data?.choices;
      const content = choices?.[0]?.message?.content;
      const reasoningContent = choices?.[0]?.message?.reasoning_content;
      const finishReason = choices?.[0]?.finish_reason;

      if (!content || content.length < MIN_CONTENT_LENGTH) {
        if (finishReason === "length") {
          throw new Error(
            `LLM hit token limit (finish_reason: length). Reasoning consumed all ${maxOutputTokens} tokens with none left for output. ` +
              `Increase max-output-tokens or reduce reasoning-effort.`,
          );
        }
        throw new Error(
          `LLM returned empty/short response: content too short (${content?.length || 0} chars, finish_reason: ${finishReason || "unknown"})`,
        );
      }

      if (content.length < SHORT_CONTENT_WARNING_LENGTH) {
        core.warning(`LLM response is suspiciously short (${content.length} chars): "${content}"`);
      }

      if (reasoningContent && process.env.LIVVIE_VERBOSE === "1") {
        core.info("=== Reasoning trace ===");
        const trace =
          reasoningContent.length > 2000
            ? reasoningContent.slice(0, 2000) + "...(truncated)"
            : reasoningContent;
        core.info(trace);
        core.info("=== End reasoning trace ===");
      }

      return { content, modelUsed: model };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isRetryable = isRetryableError(lastError, lastResponseStatus);

      if (!isRetryable) {
        core.warning(`Batch model returned non-retryable error: ${lastError.message}`);
        break;
      }

      if (attempt < maxRetries) {
        const delay = calculateBackoff(attempt);
        core.warning(
          `LLM request failed (attempt ${attempt}/${maxRetries}): ${lastError.message}. Retrying in ${Math.round(delay / 1000)}s...`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error("LLM request failed after retries");
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(error: Error, status?: number): boolean {
  if (status !== undefined) {
    if (isRetryableHttpStatus(status)) return true;
    if (status >= 400 && status < 500 && status !== 429) return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("llm returned empty response body") ||
    message.includes("aborted") ||
    message.includes("fetch failed") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("timeout")
  );
}
