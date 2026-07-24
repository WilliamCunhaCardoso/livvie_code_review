import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

import {
  extractFindingId,
  fetchDismissSignals,
  applyDismissSignals,
  findFindingByReplyFuzzy,
} from "./review-dismissal.js";
import type { ReviewFinding } from "./types.js";

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "abc123",
    severity: "high",
    confidence: "high",
    file: "lib/main.dart",
    line: 10,
    description: "Missing null check before accessing value",
    suggestion: "if (value == null) return;",
    suggestionStartLine: 8,
    perspective: "security",
    foundBy: ["security"],
    ...overrides,
  };
}

describe("extractFindingId", () => {
  it("extracts id from marker", () => {
    const body = "Some comment\n\n<!-- livvie:finding-id:abc123 -->";
    expect(extractFindingId(body)).toBe("abc123");
  });

  it("returns null when marker is absent", () => {
    expect(extractFindingId("No marker here")).toBeNull();
  });
});

describe("fetchDismissSignals", () => {
  function makeOctokit(graphqlResult: unknown, restComments: unknown[] = []) {
    return {
      graphql: vi.fn().mockResolvedValue(graphqlResult),
      paginate: vi.fn().mockResolvedValue(restComments),
      rest: {
        pulls: {
          listReviewComments: vi.fn(),
        },
      },
    } as unknown as import("@octokit/rest").Octokit;
  }

  it("returns signal for resolved bot thread", async () => {
    const octokit = makeOctokit({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "thread1",
                isResolved: true,
                comments: {
                  nodes: [
                    {
                      body: "Finding body\n\n<!-- livvie:finding-id:abc123 -->",
                      databaseId: 100,
                      author: { login: "livvie-code-review[bot]" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    const signals = await fetchDismissSignals(octokit, "owner", "repo", 1);
    expect(signals).toHaveLength(1);
    expect(signals[0].findingId).toBe("abc123");
    expect(signals[0].source).toBe("resolved-thread");
  });

  it("ignores unresolved threads", async () => {
    const octokit = makeOctokit({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "thread1",
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      body: "<!-- livvie:finding-id:abc123 -->",
                      databaseId: 100,
                      author: { login: "livvie-code-review[bot]" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    const signals = await fetchDismissSignals(octokit, "owner", "repo", 1);
    expect(signals).toHaveLength(0);
  });

  it("ignores resolved threads not started by bot", async () => {
    const octokit = makeOctokit({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "thread1",
                isResolved: true,
                comments: {
                  nodes: [
                    {
                      body: "Human reviewer comment",
                      databaseId: 100,
                      author: { login: "reviewer" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    const signals = await fetchDismissSignals(octokit, "owner", "repo", 1);
    expect(signals).toHaveLength(0);
  });

  it("returns signal for author reply to bot comment", async () => {
    const octokit = makeOctokit({ repository: { pullRequest: { reviewThreads: { nodes: [] } } } }, [
      {
        id: 100,
        body: "Finding body\n\n<!-- livvie:finding-id:abc123 -->",
        user: { login: "livvie-code-review[bot]", type: "Bot" },
        in_reply_to_id: null,
      },
      {
        id: 101,
        body: "Please ignore this for now.",
        user: { login: "author", type: "User" },
        in_reply_to_id: 100,
      },
    ]);

    const signals = await fetchDismissSignals(octokit, "owner", "repo", 1);
    expect(signals).toHaveLength(1);
    expect(signals[0].findingId).toBe("abc123");
    expect(signals[0].source).toBe("author-reply");
  });

  it("deduplicates signals for the same finding", async () => {
    const octokit = makeOctokit(
      {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread1",
                  isResolved: true,
                  comments: {
                    nodes: [
                      {
                        body: "<!-- livvie:finding-id:abc123 -->",
                        databaseId: 100,
                        author: { login: "livvie-code-review[bot]" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
      [
        {
          id: 100,
          body: "<!-- livvie:finding-id:abc123 -->",
          user: { login: "livvie-code-review[bot]", type: "Bot" },
          in_reply_to_id: null,
        },
        {
          id: 101,
          body: "Please ignore.",
          user: { login: "author", type: "User" },
          in_reply_to_id: 100,
        },
      ],
    );

    const signals = await fetchDismissSignals(octokit, "owner", "repo", 1);
    expect(signals).toHaveLength(1);
  });

  it("returns empty on GraphQL error", async () => {
    const octokit = {
      graphql: vi.fn().mockRejectedValue(new Error("GraphQL error")),
      paginate: vi.fn().mockResolvedValue([]),
      rest: {
        pulls: {
          listReviewComments: vi.fn(),
        },
      },
    } as unknown as import("@octokit/rest").Octokit;

    const signals = await fetchDismissSignals(octokit, "owner", "repo", 1);
    expect(signals).toHaveLength(0);
  });
});

describe("applyDismissSignals", () => {
  it("removes findings with signals", () => {
    const findings = [makeFinding({ id: "abc123" }), makeFinding({ id: "def456" })];
    const signals = [
      { findingId: "abc123", reason: "Resolved", source: "resolved-thread" as const },
    ];
    const { kept, dismissed } = applyDismissSignals(findings, signals);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe("def456");
    expect(dismissed).toHaveLength(1);
  });

  it("keeps all findings when no signals", () => {
    const findings = [makeFinding()];
    const { kept } = applyDismissSignals(findings, []);
    expect(kept).toHaveLength(1);
  });
});

describe("findFindingByReplyFuzzy", () => {
  it("matches finding by file and line in reply body", () => {
    const finding = makeFinding({ id: "new-id", file: "lib/image_uploader.dart", line: 42 });
    const replies = [
      {
        findingId: "old-id",
        replyBody: "Please skip `image_uploader.dart:42`.",
        replyAuthor: "author",
        originalCommentId: 100,
        replyCommentId: 101,
      },
    ];
    const matched = findFindingByReplyFuzzy([finding], "old-id", replies);
    expect(matched).toBeDefined();
    expect(matched?.id).toBe("new-id");
  });
});
