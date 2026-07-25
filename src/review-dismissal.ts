import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import type { ReviewFinding } from "./types.js";
import { extractFindingId } from "./finding-format.js";

const MIN_REPLY_LENGTH = 10;
const REVIEW_THREADS_PAGE_SIZE = 100;

export interface DismissSignal {
  findingId: string;
  reason: string;
  source: "resolved-thread" | "author-reply";
}

export interface AuthorReply {
  findingId: string;
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
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    };
  };
}

export interface DismissSignalFetchResult {
  signals: DismissSignal[];
  errors: string[];
}

export async function fetchDismissSignals(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  prAuthorLogin: string,
): Promise<DismissSignalFetchResult> {
  const errors: string[] = [];

  const [resolvedThreadResult, replyResult] = await Promise.all([
    fetchResolvedThreadSignals(octokit, owner, repo, pullNumber).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`resolved-thread fetch failed: ${message}`);
      return [] as DismissSignal[];
    }),
    fetchAuthorReplySignals(octokit, owner, repo, pullNumber, prAuthorLogin).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`author-reply fetch failed: ${message}`);
      return [] as DismissSignal[];
    }),
  ]);

  const signals = [...resolvedThreadResult];
  const seenFindingIds = new Set(resolvedThreadResult.map((s) => s.findingId));

  for (const reply of replyResult) {
    if (seenFindingIds.has(reply.findingId)) continue;
    signals.push(reply);
    seenFindingIds.add(reply.findingId);
  }

  for (const error of errors) {
    core.warning(error);
  }

  return { signals, errors };
}

async function fetchResolvedThreadSignals(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<DismissSignal[]> {
  const signals: DismissSignal[] = [];
  let cursor: string | null = null;

  while (true) {
    const response = (await octokit.graphql(
      `
      query ReviewThreads($owner: String!, $repo: String!, $pullNumber: Int!, $first: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pullNumber) {
            reviewThreads(first: $first, after: $after) {
              nodes {
                id
                isResolved
                comments(first: 100) {
                  nodes {
                    body
                    author {
                      login
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
      `,
      { owner, repo, pullNumber, first: REVIEW_THREADS_PAGE_SIZE, after: cursor },
    )) as GraphQLReviewThreadsResponse;

    const threads = response?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

    for (const thread of threads) {
      if (!thread.isResolved) continue;

      const findingId = findBotFindingIdInThread(thread);
      if (!findingId) continue;

      signals.push({
        findingId,
        reason: "Review thread was resolved on GitHub",
        source: "resolved-thread",
      });
    }

    const pageInfo = response?.repository?.pullRequest?.reviewThreads?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return signals;
}

function findBotFindingIdInThread(thread: ReviewThreadNode): string | null {
  const comments = thread.comments?.nodes ?? [];
  for (const comment of comments) {
    if (!isBotLogin(comment.author?.login)) continue;
    const findingId = extractFindingId(comment.body ?? "");
    if (findingId) return findingId;
  }
  return null;
}

async function fetchAuthorReplySignals(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  prAuthorLogin: string,
): Promise<DismissSignal[]> {
  const replies = await fetchAuthorReplies(octokit, owner, repo, pullNumber, prAuthorLogin);

  return replies.map((reply) => ({
    findingId: reply.findingId,
    reason: `Author ${reply.replyAuthor} replied to bot comment`,
    source: "author-reply",
  }));
}

async function fetchAuthorReplies(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  prAuthorLogin: string,
): Promise<AuthorReply[]> {
  const replies: AuthorReply[] = [];

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
    if (!comment.user.login || comment.user.login !== prAuthorLogin) continue;

    const replyBody = comment.body || "";
    if (replyBody.trim().length < MIN_REPLY_LENGTH) continue;

    replies.push({
      findingId,
      replyAuthor: comment.user.login,
      originalCommentId: comment.in_reply_to_id,
      replyCommentId: comment.id,
    });
  }

  return replies;
}

function isBotLogin(login: string | null | undefined): boolean {
  if (!login) return false;
  return login.endsWith("[bot]");
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
