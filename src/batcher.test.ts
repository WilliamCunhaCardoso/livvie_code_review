import { describe, it, expect, vi } from "vitest";

// Mock @actions/core before importing batcher
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

// Mock tokenizer — simple char-count approximation
vi.mock("./tokenizer.js", () => ({
  countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

// Mock truncation
vi.mock("./truncation.js", () => ({
  progressiveTruncate: vi.fn((content: string, _patch: string, _budget: number) => ({
    content: content.substring(0, 100),
    truncated: true,
  })),
  truncateToWindow: vi.fn((content: string, _patch: string, _windowLines: number) => ({
    content: content,
    truncated: false,
  })),
  truncateTextToBudget: vi.fn((content: string, _budget: number) => ({
    content: content.substring(0, 100),
    truncated: true,
  })),
}));

// Mock cross-file context builder
vi.mock("./cross-file.js", () => ({
  buildCrossFileContext: vi.fn((_batches: unknown, _batch: unknown, _budget: number) => {
    return "cross-file-context";
  }),
}));

import { prepareFiles, binPackFiles, assignCrossFileContext, createBatches } from "./batcher.js";
import type { DiffFile, PreparedFile, TokenBudget, Batch } from "./types.js";
import * as core from "@actions/core";

function makeFile(name: string, _content: string): DiffFile {
  return {
    filename: name,
    patch: `@@ -1,1 +1,1 @@\n-old\n+new`,
    additions: 1,
    deletions: 1,
  };
}

function makeBudget(overrides?: Partial<TokenBudget>): TokenBudget {
  return {
    contextWindow: 128000,
    maxOutput: 16384,
    systemPromptTokens: 2000,
    reviewInstructionsTokens: 500,
    crossFileHunksTokens: 1000,
    safetyMargin: 2000,
    fileBudget: 50000,
    ...overrides,
  };
}

describe("prepareFiles", () => {
  it("returns PreparedFile with correct fields when diffContextLines is 0", () => {
    const files = [makeFile("src/main.dart", "void main() {}")];
    const contents = new Map([["src/main.dart", "void main() {}"]]);
    const budget = makeBudget();

    const result = prepareFiles(files, contents, budget, 0);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("src/main.dart");
    expect(result[0].content).toBe(files[0].patch);
    expect(result[0].additions).toBe(1);
    expect(result[0].deletions).toBe(1);
    expect(result[0].directory).toBe("src");
    expect(result[0].tokenCount).toBeGreaterThan(0);
    expect(result[0].truncated).toBe(false);
  });

  it("handles missing file content", () => {
    const files = [makeFile("src/missing.dart", "")];
    const contents = new Map<string, string>();
    const budget = makeBudget();

    const result = prepareFiles(files, contents, budget, 0);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(files[0].patch);
  });

  it("truncates files exceeding token budget when diffContextLines is 0", () => {
    const bigPatch = "+x".repeat(1000);
    const files: DiffFile[] = [
      {
        filename: "src/big.dart",
        patch: `@@ -1,1 +1,1 @@\n${bigPatch}`,
        additions: 1,
        deletions: 1,
      },
    ];
    const contents = new Map([["src/big.dart", "x".repeat(1000)]]);
    const budget = makeBudget({ fileBudget: 10 });

    const result = prepareFiles(files, contents, budget, 0);
    expect(result).toHaveLength(1);
    expect(result[0].truncated).toBe(true);
    expect(result[0].content.length).toBeLessThan(bigPatch.length);
  });
  it("applies truncateToWindow when diffContextLines > 0", () => {
    const files = [makeFile("src/main.dart", "void main() {}")];
    const contents = new Map([["src/main.dart", "void main() {}"]]);
    const budget = makeBudget();

    const result = prepareFiles(files, contents, budget, 15);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("void main() {}");
    expect(result[0].truncated).toBe(false);
  });

  it("uses raw patch as content when diffContextLines === 0", () => {
    const files = [makeFile("src/main.dart", "void main() {}")];
    const contents = new Map([["src/main.dart", "void main() {}"]]);
    const budget = makeBudget();

    const result = prepareFiles(files, contents, budget, 0);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(files[0].patch);
    expect(result[0].truncated).toBe(false);
  });

  it("falls back to progressiveTruncate when windowed content exceeds budget", () => {
    const bigContent = "x".repeat(1000);
    const files = [makeFile("src/big.dart", bigContent)];
    const contents = new Map([["src/big.dart", bigContent]]);
    const budget = makeBudget({ fileBudget: 10 });

    const result = prepareFiles(files, contents, budget, 15);
    expect(result).toHaveLength(1);
    expect(result[0].truncated).toBe(true);
    expect(result[0].content.length).toBeLessThan(bigContent.length);
  });
});

describe("binPackFiles", () => {
  it("single file fits in one batch", () => {
    const file: PreparedFile = {
      filename: "src/main.dart",
      patch: "",
      additions: 1,
      deletions: 0,
      content: "small content",
      tokenCount: 100,
      truncated: false,
      directory: "src",
    };
    const budget = makeBudget({ fileBudget: 10000 });

    const batches = binPackFiles([file], budget, 0, []);
    expect(batches).toHaveLength(1);
    expect(batches[0].files).toHaveLength(1);
    expect(batches[0].tokenCount).toBe(100);
  });

  it("two small files → same batch (if under budget)", () => {
    const files: PreparedFile[] = [
      {
        filename: "src/a.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "content a",
        tokenCount: 100,
        truncated: false,
        directory: "src",
      },
      {
        filename: "src/b.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "content b",
        tokenCount: 100,
        truncated: false,
        directory: "src",
      },
    ];
    const budget = makeBudget({ fileBudget: 10000 });

    const batches = binPackFiles(files, budget, 0, []);
    expect(batches).toHaveLength(1);
    expect(batches[0].files).toHaveLength(2);
  });

  it("two large files → separate batches", () => {
    const files: PreparedFile[] = [
      {
        filename: "src/a.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "big content a",
        tokenCount: 40000,
        truncated: false,
        directory: "src",
      },
      {
        filename: "src/b.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "big content b",
        tokenCount: 40000,
        truncated: false,
        directory: "src",
      },
    ];
    const budget = makeBudget({ fileBudget: 50000 });

    const batches = binPackFiles(files, budget, 0, []);
    // Each file is 40k tokens, budget is 50k — they can't fit in the same batch
    expect(batches).toHaveLength(2);
    expect(batches[0].files).toHaveLength(1);
    expect(batches[1].files).toHaveLength(1);
  });

  it("maxBatches=1 → rejects files exceeding single-file budget as unreviewable", () => {
    const files: PreparedFile[] = [
      {
        filename: "src/a.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "content a",
        tokenCount: 55000,
        truncated: false,
        directory: "src",
      },
      {
        filename: "src/b.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "content b",
        tokenCount: 55000,
        truncated: false,
        directory: "src",
      },
    ];
    const budget = makeBudget({ fileBudget: 50000 });
    const unreviewable: string[] = [];

    const batches = binPackFiles(files, budget, 1, unreviewable);
    expect(batches).toHaveLength(0);
    expect(unreviewable).toContain("src/a.dart");
    expect(unreviewable).toContain("src/b.dart");
    expect(core.warning).toHaveBeenCalled();
  });

  it("does not corrupt directory affinity when first-fit fills a different batch", () => {
    // Two files in the same directory that cannot share a batch.
    // A third small file in a different directory should not steal the directory map.
    const files: PreparedFile[] = [
      {
        filename: "lib/a.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "a",
        tokenCount: 40000,
        truncated: false,
        directory: "lib",
      },
      {
        filename: "test/x.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "x",
        tokenCount: 100,
        truncated: false,
        directory: "test",
      },
      {
        filename: "lib/b.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "b",
        tokenCount: 40000,
        truncated: false,
        directory: "lib",
      },
    ];
    const budget = makeBudget({ fileBudget: 50000 });

    const batches = binPackFiles(files, budget, 0, []);
    // lib/a.dart -> batch 0, test/x.dart fits in batch 0 by first-fit,
    // lib/b.dart must NOT be forced into batch 0 because of corrupted directory map.
    expect(batches).toHaveLength(2);
    expect(batches[0].files.map((f) => f.filename)).toEqual(["lib/a.dart", "test/x.dart"]);
    expect(batches[1].files.map((f) => f.filename)).toEqual(["lib/b.dart"]);
  });

  it("maxBatches=0 → unlimited batches", () => {
    const files: PreparedFile[] = Array.from({ length: 10 }, (_, i) => ({
      filename: `src/file${i}.dart`,
      patch: "",
      additions: 1,
      deletions: 0,
      content: `content ${i}`,
      tokenCount: 45000,
      truncated: false,
      directory: "src",
    }));
    const budget = makeBudget({ fileBudget: 50000 });

    const batches = binPackFiles(files, budget, 0, []);
    // Each file is 45k, budget 50k, each needs its own batch
    expect(batches).toHaveLength(10);
  });

  it("files sorted by directory → same directory preferentially grouped", () => {
    const files: PreparedFile[] = [
      {
        filename: "lib/a.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "a",
        tokenCount: 200,
        truncated: false,
        directory: "lib",
      },
      {
        filename: "test/b.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "b",
        tokenCount: 200,
        truncated: false,
        directory: "test",
      },
      {
        filename: "lib/c.dart",
        patch: "",
        additions: 1,
        deletions: 0,
        content: "c",
        tokenCount: 200,
        truncated: false,
        directory: "lib",
      },
    ];
    const budget = makeBudget({ fileBudget: 10000 });

    const batches = binPackFiles(files, budget, 0, []);
    // lib/a.dart goes into batch 0, test/b.dart can fit → batch 0,
    // lib/c.dart prefers batch 0 (same directory) → batch 0
    expect(batches).toHaveLength(1);
    // All files should be in the same batch since they're small enough
    expect(batches[0].files).toHaveLength(3);
    // lib files should be adjacent in the batch (sorted order)
    const filenames = batches[0].files.map((f) => f.filename);
    expect(filenames).toEqual(["lib/a.dart", "lib/c.dart", "test/b.dart"]);
  });
});

describe("assignCrossFileContext", () => {
  it("sets crossFileContext and totalTokenCount on each batch", () => {
    const batches: Batch[] = [
      {
        index: 0,
        files: [
          {
            filename: "src/a.dart",
            patch: "",
            additions: 1,
            deletions: 0,
            content: "a",
            tokenCount: 100,
            truncated: false,
            directory: "src",
          },
        ],
        tokenCount: 100,
        crossFileContext: "",
        totalTokenCount: 100,
      },
    ];
    const budget = makeBudget();

    assignCrossFileContext(batches, budget);
    expect(batches[0].crossFileContext).toBe("cross-file-context");
    expect(batches[0].totalTokenCount).toBeGreaterThan(100);
  });
});

describe("createBatches", () => {
  it("full pipeline: files → prepared → batches with cross-file context", () => {
    const files: DiffFile[] = [
      makeFile("src/main.dart", "void main() {}"),
      makeFile("lib/utils.dart", "int add(int a, int b) => a + b;"),
    ];
    const contents = new Map([
      ["src/main.dart", "void main() {}"],
      ["lib/utils.dart", "int add(int a, int b) => a + b;"],
    ]);
    const budget = makeBudget();

    const batches = createBatches(files, contents, budget, 0, 0);
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0].files.length).toBeGreaterThan(0);
    expect(batches[0].crossFileContext).toBe("cross-file-context");
    expect(batches[0].totalTokenCount).toBeGreaterThan(0);
  });
});
