import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

import { extractFindingId } from "./finding-format.js";
import { fetchDismissSignals, applyDismissSignals } from "./review-dismissal.js";
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

const BOT_LOGIN = "livvie-code-review[bot]";
const AUTHOR_LOGIN = "author";

describe("fetchDismissSignals", () => {
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
                      author: { login: BOT_LOGIN },
                    },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].findingId).toBe("abc123");
    expect(result.signals[0].source).toBe("resolved-thread");
    expect(result.errors).toHaveLength(0);
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
                      author: { login: BOT_LOGIN },
                    },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(0);
  });

  it("detects bot comment anywhere in thread, not just first", async () => {
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
                      author: { login: "reviewer" },
                    },
                    {
                      body: "Bot finding\n\n<!-- livvie:finding-id:abc123 -->",
                      author: { login: BOT_LOGIN },
                    },
                    {
                      body: "Reply to bot",
                      author: { login: AUTHOR_LOGIN },
                    },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].source).toBe("resolved-thread");
  });

  it("ignores resolved threads with no bot comment", async () => {
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
                      body: "Human-only thread",
                      author: { login: "reviewer" },
                    },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(0);
  });

  it("returns signal for author reply to bot comment", async () => {
    const octokit = makeOctokit(
      {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
      [
        {
          id: 100,
          body: "Finding body\n\n<!-- livvie:finding-id:abc123 -->",
          user: { login: BOT_LOGIN, type: "Bot" },
          in_reply_to_id: null,
        },
        {
          id: 101,
          body: "Please ignore this for now.",
          user: { login: AUTHOR_LOGIN, type: "User" },
          in_reply_to_id: 100,
        },
      ],
    );

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].findingId).toBe("abc123");
    expect(result.signals[0].source).toBe("author-reply");
  });

  it("ignores replies from non-author users", async () => {
    const octokit = makeOctokit(
      {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
      [
        {
          id: 100,
          body: "<!-- livvie:finding-id:abc123 -->",
          user: { login: BOT_LOGIN, type: "Bot" },
          in_reply_to_id: null,
        },
        {
          id: 101,
          body: "Looks fine to me.",
          user: { login: "random-reviewer", type: "User" },
          in_reply_to_id: 100,
        },
      ],
    );

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(0);
  });

  it("ignores very short replies", async () => {
    const octokit = makeOctokit(
      {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
      [
        {
          id: 100,
          body: "<!-- livvie:finding-id:abc123 -->",
          user: { login: BOT_LOGIN, type: "Bot" },
          in_reply_to_id: null,
        },
        {
          id: 101,
          body: "ok",
          user: { login: AUTHOR_LOGIN, type: "User" },
          in_reply_to_id: 100,
        },
      ],
    );

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(0);
  });

  it("ignores bot replies to bot comments", async () => {
    const octokit = makeOctokit(
      {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
      [
        {
          id: 100,
          body: "<!-- livvie:finding-id:abc123 -->",
          user: { login: BOT_LOGIN, type: "Bot" },
          in_reply_to_id: null,
        },
        {
          id: 101,
          body: "Automated bot reply",
          user: { login: "dependabot[bot]", type: "Bot" },
          in_reply_to_id: 100,
        },
      ],
    );

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(0);
  });

  it("does not classify human users with 'bot' in name as bots", async () => {
    const octokit = makeOctokit(
      {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
      [
        {
          id: 100,
          body: "<!-- livvie:finding-id:abc123 -->",
          user: { login: BOT_LOGIN, type: "Bot" },
          in_reply_to_id: null,
        },
        {
          id: 101,
          body: "Please ignore this finding.",
          user: { login: AUTHOR_LOGIN, type: "User" },
          in_reply_to_id: 100,
        },
      ],
    );

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].source).toBe("author-reply");
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
                        author: { login: BOT_LOGIN },
                      },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      [
        {
          id: 100,
          body: "<!-- livvie:finding-id:abc123 -->",
          user: { login: BOT_LOGIN, type: "Bot" },
          in_reply_to_id: null,
        },
        {
          id: 101,
          body: "Please ignore this.",
          user: { login: AUTHOR_LOGIN, type: "User" },
          in_reply_to_id: 100,
        },
      ],
    );

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(1);
  });

  it("returns errors on GraphQL failure but still fetches replies", async () => {
    const octokit = makeOctokit(
      {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
      [
        {
          id: 100,
          body: "<!-- livvie:finding-id:abc123 -->",
          user: { login: BOT_LOGIN, type: "Bot" },
          in_reply_to_id: null,
        },
        {
          id: 101,
          body: "Please ignore this finding.",
          user: { login: AUTHOR_LOGIN, type: "User" },
          in_reply_to_id: 100,
        },
      ],
    );
    (octokit as unknown as { graphql: ReturnType<typeof vi.fn> }).graphql = vi
      .fn()
      .mockRejectedValue(new Error("GraphQL error"));

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].source).toBe("author-reply");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("resolved-thread fetch failed");
  });

  it("paginates GraphQL when hasNextPage is true", async () => {
    let callCount = 0;
    const octokit = {
      graphql: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
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
                            author: { login: BOT_LOGIN },
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                },
              },
            },
          };
        }
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "thread2",
                    isResolved: true,
                    comments: {
                      nodes: [
                        {
                          body: "<!-- livvie:finding-id:def456 -->",
                          author: { login: BOT_LOGIN },
                        },
                      ],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      }),
      paginate: vi.fn().mockResolvedValue([]),
      rest: {
        pulls: {
          listReviewComments: vi.fn(),
        },
      },
    } as unknown as import("@octokit/rest").Octokit;

    const result = await fetchDismissSignals(octokit, "owner", "repo", 1, AUTHOR_LOGIN);
    expect(result.signals).toHaveLength(2);
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
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
