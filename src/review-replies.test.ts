import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

import {
  extractFindingId,
  fetchAuthorReplies,
  filterDismissedFindings,
  evaluateAuthorReplies,
} from "./review-replies.js";
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

  it("returns null for malformed marker", () => {
    expect(extractFindingId("<!-- livvie:finding-id: -->")).toBeNull();
  });
});

describe("fetchAuthorReplies", () => {
  function makeOctokit(comments: unknown[]) {
    return {
      rest: {
        pulls: {
          listReviewComments: vi.fn(),
        },
      },
      paginate: vi.fn().mockResolvedValue(comments),
    } as unknown as import("@octokit/rest").Octokit;
  }

  it("returns replies to bot comments with finding id", async () => {
    const comments = [
      {
        id: 100,
        body: "Finding body\n\n<!-- livvie:finding-id:abc123 -->",
        user: { login: "livvie-code-review[bot]", type: "Bot" },
        in_reply_to_id: null,
      },
      {
        id: 101,
        body: "This is actually handled above.",
        user: { login: "author", type: "User" },
        in_reply_to_id: 100,
      },
    ];

    const replies = await fetchAuthorReplies(makeOctokit(comments), "owner", "repo", 1);
    expect(replies).toHaveLength(1);
    expect(replies[0].findingId).toBe("abc123");
    expect(replies[0].replyAuthor).toBe("author");
    expect(replies[0].replyBody).toBe("This is actually handled above.");
  });

  it("ignores replies from bots", async () => {
    const comments = [
      {
        id: 100,
        body: "<!-- livvie:finding-id:abc123 -->",
        user: { login: "livvie-code-review[bot]", type: "Bot" },
        in_reply_to_id: null,
      },
      {
        id: 101,
        body: "Ack",
        user: { login: "some-bot[bot]", type: "Bot" },
        in_reply_to_id: 100,
      },
    ];

    const replies = await fetchAuthorReplies(makeOctokit(comments), "owner", "repo", 1);
    expect(replies).toHaveLength(0);
  });

  it("ignores comments without finding marker", async () => {
    const comments = [
      {
        id: 100,
        body: "Regular bot comment without marker",
        user: { login: "livvie-code-review[bot]", type: "Bot" },
        in_reply_to_id: null,
      },
      {
        id: 101,
        body: "Reply",
        user: { login: "author", type: "User" },
        in_reply_to_id: 100,
      },
    ];

    const replies = await fetchAuthorReplies(makeOctokit(comments), "owner", "repo", 1);
    expect(replies).toHaveLength(0);
  });

  it("groups multiple replies to the same finding", async () => {
    const comments = [
      {
        id: 100,
        body: "<!-- livvie:finding-id:abc123 -->",
        user: { login: "livvie-code-review[bot]", type: "Bot" },
        in_reply_to_id: null,
      },
      {
        id: 101,
        body: "First reply",
        user: { login: "author", type: "User" },
        in_reply_to_id: 100,
      },
      {
        id: 102,
        body: "Second reply",
        user: { login: "reviewer", type: "User" },
        in_reply_to_id: 100,
      },
    ];

    const replies = await fetchAuthorReplies(makeOctokit(comments), "owner", "repo", 1);
    expect(replies).toHaveLength(2);
    expect(replies.every((r) => r.findingId === "abc123")).toBe(true);
  });
});

describe("filterDismissedFindings", () => {
  it("removes findings whose id is dismissed", () => {
    const findings = [makeFinding({ id: "abc123" }), makeFinding({ id: "def456" })];
    const dismissed = [{ findingId: "abc123", reason: "Author explained it" }];
    const { kept } = filterDismissedFindings(findings, dismissed);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe("def456");
  });

  it("keeps all findings when no dismissals", () => {
    const findings = [makeFinding({ id: "abc123" })];
    const { kept } = filterDismissedFindings(findings, []);
    expect(kept).toHaveLength(1);
  });
});

describe("evaluateAuthorReplies", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn();
  });

  it("returns empty when no replies", async () => {
    const result = await evaluateAuthorReplies([], [], {
      apiKey: "key",
      baseUrl: "https://api.example.com",
      model: "model",
      maxOutputTokens: 1000,
    });
    expect(result).toHaveLength(0);
  });

  it("skips replies for unknown findings", async () => {
    const replies = [
      {
        findingId: "unknown",
        replyBody: "reply",
        replyAuthor: "author",
        originalCommentId: 100,
        replyCommentId: 101,
      },
    ];
    const result = await evaluateAuthorReplies([makeFinding({ id: "abc123" })], replies, {
      apiKey: "key",
      baseUrl: "https://api.example.com",
      model: "model",
      maxOutputTokens: 1000,
    });
    expect(result).toHaveLength(0);
  });

  it("dismisses finding when LLM accepts justification", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: JSON.stringify({ accepted: true, reason: "Valid explanation" }) } },
        ],
      }),
    } as unknown as Response);

    const replies = [
      {
        findingId: "abc123",
        replyBody: "This is checked earlier in the method.",
        replyAuthor: "author",
        originalCommentId: 100,
        replyCommentId: 101,
      },
    ];
    const result = await evaluateAuthorReplies([makeFinding()], replies, {
      apiKey: "key",
      baseUrl: "https://api.example.com",
      model: "model",
      maxOutputTokens: 1000,
    });

    expect(result).toHaveLength(1);
    expect(result[0].findingId).toBe("abc123");
    expect(result[0].reason).toBe("Valid explanation");
  });

  it("matches reply to a finding by file and line when id changed", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: JSON.stringify({ accepted: true, reason: "Out of scope" }) } },
        ],
      }),
    } as unknown as Response);

    const finding = makeFinding({ id: "new-id-xyz", file: "lib/image_uploader.dart", line: 42 });
    const replies = [
      {
        findingId: "old-id-abc",
        replyBody:
          "This `image_uploader.dart:42` finding is about a shared component not changed in this PR.",
        replyAuthor: "author",
        originalCommentId: 100,
        replyCommentId: 101,
      },
    ];
    const result = await evaluateAuthorReplies([finding], replies, {
      apiKey: "key",
      baseUrl: "https://api.example.com",
      model: "model",
      maxOutputTokens: 1000,
    });

    expect(result).toHaveLength(1);
    expect(result[0].findingId).toBe("new-id-xyz");
  });

  it("does not dismiss when LLM rejects justification", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: JSON.stringify({ accepted: false, reason: "Not convincing" }) } },
        ],
      }),
    } as unknown as Response);

    const replies = [
      {
        findingId: "abc123",
        replyBody: "I don't want to change it.",
        replyAuthor: "author",
        originalCommentId: 100,
        replyCommentId: 101,
      },
    ];
    const result = await evaluateAuthorReplies([makeFinding()], replies, {
      apiKey: "key",
      baseUrl: "https://api.example.com",
      model: "model",
      maxOutputTokens: 1000,
    });

    expect(result).toHaveLength(0);
  });
});
