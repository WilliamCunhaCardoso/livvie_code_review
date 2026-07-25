import { countTokens } from "./tokenizer.js";

const HUNK_HEADER_RE = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function extractChangedLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let currentLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = line.match(HUNK_HEADER_RE);
      if (match) {
        currentLine = parseInt(match[1], 10);
      }
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith("\\")) continue;

    if (line.startsWith("+")) {
      lines.add(currentLine);
      currentLine++;
    } else if (line.startsWith("-")) {
      // removed line, don't advance
    } else {
      currentLine++;
    }
  }

  return lines;
}

interface HunkRange {
  start: number;
  end: number;
}

function extractHunkRanges(patch: string): HunkRange[] {
  const ranges: HunkRange[] = [];
  let currentLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = line.match(HUNK_HEADER_RE);
      if (match) {
        currentLine = parseInt(match[1], 10);
        ranges.push({ start: currentLine, end: currentLine });
      }
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith("\\")) continue;

    const lastRange = ranges[ranges.length - 1];
    if (lastRange) {
      lastRange.end = currentLine;
    }

    if (line.startsWith("+")) {
      currentLine++;
    } else if (line.startsWith("-")) {
      // removed line, don't advance
    } else {
      currentLine++;
    }
  }

  return ranges;
}

function parseNumberedLines(content: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of content.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const numStr = line.substring(0, colonIdx);
    const num = parseInt(numStr, 10);
    if (!isNaN(num)) {
      map.set(num, line);
    }
  }
  return map;
}

export function truncateToWindow(
  content: string,
  patch: string,
  windowLines: number,
): { content: string; truncated: boolean } {
  if (!content || !patch) {
    return { content, truncated: false };
  }

  const hunkRanges = extractHunkRanges(patch);
  if (hunkRanges.length === 0) {
    return { content, truncated: false };
  }

  const lineMap = parseNumberedLines(content);
  if (lineMap.size === 0) {
    return { content, truncated: false };
  }

  let maxLine = 0;
  for (const num of Array.from(lineMap.keys())) {
    if (num > maxLine) maxLine = num;
  }
  const keepRanges: HunkRange[] = [];

  for (const hunk of hunkRanges) {
    const start = Math.max(1, hunk.start - windowLines);
    const end = Math.min(maxLine, hunk.end + windowLines);
    keepRanges.push({ start, end });
  }

  keepRanges.sort((a, b) => a.start - b.start);

  const merged: HunkRange[] = [];
  for (const range of keepRanges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  const result: string[] = [];
  let currentLineNum = 1;
  let truncated = false;

  for (const range of merged) {
    if (range.start > currentLineNum) {
      const gap = range.start - currentLineNum;
      result.push(`\u2026 (${gap} ${gap === 1 ? "line" : "lines"} truncated) \u2026`);
      truncated = true;
    }
    for (let num = range.start; num <= range.end; num++) {
      const line = lineMap.get(num);
      if (line !== undefined) {
        result.push(line);
      }
    }
    currentLineNum = range.end + 1;
  }

  if (currentLineNum <= maxLine) {
    const gap = maxLine - currentLineNum + 1;
    result.push(`\u2026 (${gap} ${gap === 1 ? "line" : "lines"} truncated) \u2026`);
    truncated = true;
  }

  return { content: result.join("\n"), truncated };
}

export function truncateTextToBudget(
  text: string,
  maxTokens: number,
): { content: string; truncated: boolean } {
  if (!text) return { content: text, truncated: false };
  if (countTokens(text) <= maxTokens) return { content: text, truncated: false };

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countTokens(text.slice(0, mid)) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return { content: text.slice(0, low), truncated: true };
}

export function progressiveTruncate(
  content: string,
  patch: string,
  maxTokens: number,
): {
  content: string;
  truncated: boolean;
  strategy: "full" | "window-10" | "window-5" | "diff-only";
} {
  if (countTokens(content) <= maxTokens) {
    return { content, truncated: false, strategy: "full" };
  }

  const window10 = truncateToWindow(content, patch, 10);
  if (countTokens(window10.content) <= maxTokens) {
    return { content: window10.content, truncated: true, strategy: "window-10" };
  }

  const window5 = truncateToWindow(content, patch, 5);
  if (countTokens(window5.content) <= maxTokens) {
    return { content: window5.content, truncated: true, strategy: "window-5" };
  }

  // Fall back to the raw patch, but never return more tokens than the budget
  // allows — even a diff-only view must fit inside the batch.
  const capped = truncateTextToBudget(patch, maxTokens);
  return { content: capped.content, truncated: true, strategy: "diff-only" };
}
