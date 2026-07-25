import type { DiffFile, PreparedFile, Batch, TokenBudget } from "./types.js";
import * as core from "@actions/core";
import { countTokens } from "./tokenizer.js";
import { progressiveTruncate, truncateToWindow, truncateTextToBudget } from "./truncation.js";
import { buildCrossFileContext } from "./cross-file.js";

function getDirectory(filename: string): string {
  const lastSlash = filename.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return filename.substring(0, lastSlash);
}

function formatFileSection(file: PreparedFile): string {
  const parts: string[] = [];
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
  return parts.join("\n");
}

export function prepareFiles(
  files: DiffFile[],
  fileContents: Map<string, string>,
  tokenBudget: TokenBudget,
  diffContextLines: number,
): PreparedFile[] {
  const prepared: PreparedFile[] = [];

  for (const file of files) {
    const rawContent = fileContents.get(file.filename) ?? "";
    let content = rawContent;
    let truncated = false;

    if (diffContextLines === 0 && file.patch) {
      content = file.patch;
      truncated = false;
      if (countTokens(content) > tokenBudget.fileBudget) {
        const result = truncateTextToBudget(content, tokenBudget.fileBudget);
        content = result.content;
        truncated = true;
      }
    } else if (diffContextLines > 0 && content && file.patch) {
      const windowed = truncateToWindow(content, file.patch, diffContextLines);
      content = windowed.content;
      truncated = windowed.truncated;
      if (content && countTokens(content) > tokenBudget.fileBudget) {
        const result = progressiveTruncate(content, file.patch, tokenBudget.fileBudget);
        content = result.content;
        truncated = true;
      }
    } else if (content && countTokens(content) > tokenBudget.fileBudget) {
      const result = progressiveTruncate(content, file.patch, tokenBudget.fileBudget);
      content = result.content;
      truncated = true;
    }

    const tempFile: PreparedFile = {
      filename: file.filename,
      patch: file.patch,
      additions: file.additions,
      deletions: file.deletions,
      content,
      tokenCount: 0,
      truncated,
      directory: getDirectory(file.filename),
    };

    tempFile.tokenCount = countTokens(formatFileSection(tempFile));
    prepared.push(tempFile);
  }

  return prepared;
}

export function binPackFiles(
  preparedFiles: PreparedFile[],
  tokenBudget: TokenBudget,
  maxBatches: number,
  unreviewableFiles: string[],
): Batch[] {
  const sorted = [...preparedFiles].sort((a, b) => a.filename.localeCompare(b.filename));

  const batches: Batch[] = [];
  const directoryBatchIndex = new Map<string, number>();

  for (const file of sorted) {
    if (file.tokenCount > tokenBudget.fileBudget) {
      core.warning(
        `File ${file.filename} (${file.tokenCount} tokens) exceeds single-file budget (${tokenBudget.fileBudget}). Marking as unreviewable.`,
      );
      unreviewableFiles.push(file.filename);
      continue;
    }

    let targetBatch: Batch | null = null;

    const dirIndex = directoryBatchIndex.get(file.directory);
    if (dirIndex !== undefined && dirIndex < batches.length) {
      const candidate = batches[dirIndex];
      if (candidate.tokenCount + file.tokenCount <= tokenBudget.fileBudget) {
        targetBatch = candidate;
      }
    }

    if (!targetBatch) {
      for (const batch of batches) {
        if (batch.tokenCount + file.tokenCount <= tokenBudget.fileBudget) {
          targetBatch = batch;
          break;
        }
      }
    }

    if (targetBatch) {
      targetBatch.files.push(file);
      targetBatch.tokenCount += file.tokenCount;
      if (
        dirIndex !== undefined &&
        dirIndex < batches.length &&
        batches[dirIndex] === targetBatch
      ) {
        directoryBatchIndex.set(file.directory, targetBatch.index);
      }
      continue;
    }

    if (maxBatches > 0 && batches.length >= maxBatches) {
      const lastBatch = batches[batches.length - 1];
      if (lastBatch.tokenCount + file.tokenCount > tokenBudget.fileBudget) {
        core.warning(
          `Batch ${lastBatch.index} overflow: ${lastBatch.tokenCount} + ${file.tokenCount} tokens exceeds budget (${tokenBudget.fileBudget}). ` +
            `File ${file.filename} forced into last batch because max-batches=${maxBatches}. Consider increasing max-batches or context-window.`,
        );
      }
      lastBatch.files.push(file);
      lastBatch.tokenCount += file.tokenCount;
      continue;
    }

    const newBatch: Batch = {
      index: batches.length,
      files: [file],
      tokenCount: file.tokenCount,
      crossFileContext: "",
      totalTokenCount: file.tokenCount,
    };
    batches.push(newBatch);
    directoryBatchIndex.set(file.directory, newBatch.index);
  }

  return batches;
}

export function assignCrossFileContext(batches: Batch[], tokenBudget: TokenBudget): void {
  for (const batch of batches) {
    const crossContext = buildCrossFileContext(batches, batch, tokenBudget.crossFileHunksTokens);
    batch.crossFileContext = crossContext;
    batch.totalTokenCount = batch.tokenCount + countTokens(crossContext);
  }
}

export function createBatches(
  files: DiffFile[],
  fileContents: Map<string, string>,
  tokenBudget: TokenBudget,
  maxBatches: number,
  diffContextLines: number,
  failedFiles: string[] = [],
): Batch[] {
  const unreviewableFiles: string[] = [...failedFiles];
  const prepared = prepareFiles(files, fileContents, tokenBudget, diffContextLines);
  const batches = binPackFiles(prepared, tokenBudget, maxBatches, unreviewableFiles);
  assignCrossFileContext(batches, tokenBudget);
  return batches;
}
