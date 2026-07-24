import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import type { ReviewFinding } from "./types.js";
import { FINDING_ID_MARKER } from "./post.js";

const MIN_REPLY_LENGTH = 2;

export interface DismissSignal {
  findingId: string;
  reason: string;
  source: "resolved-thread" | "author-reply";
}

export interface AuthorReply {
  findingId: string;
  replyBody: string;
  replyAuthor: string;
  originalCommentId: number;
  replyCommentId: number;
}

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: Array<{
      body: string;
      databaseId: number;
      author: {
        login: string;
      };
    }>;
  };
}

interface GraphQLReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: ReviewThreadNode[];
      };
    };
  };
}

export async function fetchDismissSignals(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<DismissSignal[]> {
  const [resolvedThreadSignals, replySignals] = await Promise.all([
    fetchResolvedThreadSignals(octokit, owner, repo, pullNumber),
    fetchAuthorReplySignals(octokit, owner, repo, pullNumber),
  ]);

  const signals = [...resolvedThreadSignals];
  const seenFindingIds = new Set(resolvedThreadSignals.map((s) => s.findingId));

  for (const reply of replySignals) {
    if (seenFindingIds.has(reply.findingId)) continue;
    signals.push(reply);
    seenFindingIds.add(reply.findingId);
  }

  return signals;
}

async function fetchResolvedThreadSignals(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<DismissSignal[]> {
  const signals: DismissSignal[] = [];

  try {
    const response = (await octokit.graphql(
      `
      query ReviewThreads($owner: String!, $repo: String!, $pullNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pullNumber) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                comments(first: 1) {
                  nodes {
                    body
                    databaseId
                    author {
                      login
                    }
                  }
                }
              }
            }
          }
        }
      }
      `,
      { owner, repo, pullNumber },
    )) as GraphQLReviewThreadsResponse;

    const threads = response?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

    for (const thread of threads) {
      if (!thread.isResolved) continue;

      const firstComment = thread.comments.nodes[0];
      if (!firstComment) continue;
      if (!isBotLogin(firstComment.author.login)) continue;

      const findingId = extractFindingId(firstComment.body);
      if (!findingId) continue;

      signals.push({
        findingId,
        reason: "Review thread was resolved on GitHub",
        source: "resolved-thread",
      });
    }
  } catch (error) {
    core.warning(`Could not fetch resolved review threads via GraphQL: ${error}`);
  }

  return signals;
}

async function fetchAuthorReplySignals(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<DismissSignal[]> {
  const replies = await fetchAuthorReplies(octokit, owner, repo, pullNumber);

  return replies.map((reply) => ({
    findingId: reply.findingId,
    reason: `Author replied: ${reply.replyBody.slice(0, 100)}`,
    source: "author-reply",
  }));
}

export async function fetchAuthorReplies(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<AuthorReply[]> {
  const replies: AuthorReply[] = [];

  try {
    const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    const botComments = new Map<number, string>();
    for (const comment of comments) {
      const body = comment.body || "";
      const findingId = extractFindingId(body);
      if (
        findingId &&
        comment.user &&
        (comment.user.type === "Bot" || isBotLogin(comment.user.login))
      ) {
        botComments.set(comment.id, findingId);
      }
    }

    for (const comment of comments) {
      if (!comment.in_reply_to_id) continue;
      const findingId = botComments.get(comment.in_reply_to_id);
      if (!findingId) continue;
      if (!comment.user || comment.user.type === "Bot" || isBotLogin(comment.user.login)) continue;

      const replyBody = comment.body || "";
      if (replyBody.trim().length < MIN_REPLY_LENGTH) continue;

      replies.push({
        findingId,
        replyBody,
        replyAuthor: comment.user.login || "unknown",
        originalCommentId: comment.in_reply_to_id,
        replyCommentId: comment.id,
      });
    }
  } catch (error) {
    core.warning(`Could not fetch review comments for reply analysis: ${error}`);
  }

  return replies;
}

function isBotLogin(login: string | null | undefined): boolean {
  if (!login) return false;
  return login.endsWith("[bot]") || login.toLowerCase().includes("bot");
}

export function extractFindingId(body: string): string | null {
  const match = body.match(new RegExp(`<!--\\s*${FINDING_ID_MARKER}:([a-zA-Z0-9]+)\\s*-->`));
  return match?.[1] ?? null;
}

export function applyDismissSignals(
  findings: ReviewFinding[],
  signals: DismissSignal[],
): { kept: ReviewFinding[]; dismissed: DismissSignal[] } {
  if (signals.length === 0) {
    return { kept: findings, dismissed: [] };
  }

  const signalByFindingId = new Map<string, DismissSignal>();
  for (const signal of signals) {
    if (!signalByFindingId.has(signal.findingId)) {
      signalByFindingId.set(signal.findingId, signal);
    }
  }

  const kept: ReviewFinding[] = [];
  const dismissed: DismissSignal[] = [];

  for (const finding of findings) {
    const signal = signalByFindingId.get(finding.id);
    if (signal) {
      dismissed.push(signal);
      core.info(
        `Finding ${finding.file}:${finding.line} dismissed (${signal.source}): ${signal.reason}`,
      );
    } else {
      kept.push(finding);
    }
  }

  return { kept, dismissed };
}

export function findFindingByReplyFuzzy(
  findings: ReviewFinding[],
  findingId: string,
  replies: AuthorReply[],
): ReviewFinding | undefined {
  if (findings.length === 0) return undefined;

  const replyBody = replies
    .map((r) => r.replyBody)
    .join(" ")
    .toLowerCase();

  for (const finding of findings) {
    const fileName = finding.file.toLowerCase().split("/").pop() || "";
    const bodyHasFile = replyBody.includes(fileName);
    if (!bodyHasFile) continue;

    const bodyHasLine =
      replyBody.includes(`:${finding.line}`) || replyBody.includes(` ${finding.line} `);
    if (!bodyHasLine) continue;

    return finding;
  }

  return undefined;
}
