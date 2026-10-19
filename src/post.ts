import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import type {
  ConsolidatedReview,
  ReviewFinding,
  ReviewComment,
  DiffFile,
  SubmitAs,
} from "./types.js";
import { isLineInDiff } from "./diff.js";
import { isSuggestionBalanced } from "./suggestion.js";
import { FINDING_ID_MARKER } from "./finding-format.js";

const REVIEW_SIGNATURE = "Livvie Code Review";

export type { SubmitAs };
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * Resolves the review submission event.
 *
 * GitHub rejects APPROVE and REQUEST_CHANGES posted by the PR's own author
 * (422 "Can not approve your own pull request") — the bot that opens nightly
 * automation PRs is often the same account that runs the review. Self-authored
 * PRs must always degrade to COMMENT so the review (including inline comments)
 * still gets posted instead of failing wholesale.
 *
 * - submitAs "comment": always COMMENT (explicit override).
 * - submitAs "auto": COMMENT only when selfAuthored; otherwise legacy behavior.
 * - submitAs "approve": legacy behavior regardless of authorship.
 */
export function resolveReviewEvent(
  requestChanges: boolean,
  submitAs: SubmitAs = "auto",
  selfAuthored = false,
): ReviewEvent {
  if (submitAs === "comment") return "COMMENT";
  if (submitAs === "auto" && selfAuthored) return "COMMENT";
  return requestChanges ? "REQUEST_CHANGES" : "APPROVE";
}

function resolvePerspectiveNames(
  foundBy: string[],
  perspectiveNameMap: Map<string, string>,
): string[] {
  return foundBy.map((id) => perspectiveNameMap.get(id) ?? id);
}

export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  consolidated: ConsolidatedReview,
  files: DiffFile[],
  requestChangesOn: Set<string>,
  maxComments: number,
  perspectiveNameMap: Map<string, string>,
  respectAuthorReplies: boolean = false,
  dismissedCount: number = 0,
  options: { submitAs?: SubmitAs; selfAuthored?: boolean } = {},
): Promise<number> {
  const { comments, postedFindings } = buildComments(
    consolidated,
    files,
    maxComments,
    perspectiveNameMap,
  );
  const body = buildReviewBody(
    consolidated,
    postedFindings,
    perspectiveNameMap,
    respectAuthorReplies,
    dismissedCount,
  );

  const hasFindings = consolidated.findings.length > 0;
  const requestChanges =
    hasFindings && consolidated.findings.some((f) => requestChangesOn.has(f.severity));
  const event = resolveReviewEvent(requestChanges, options.submitAs, options.selfAuthored);

  core.info(`Posting ${event} review with ${comments.length} inline comments...`);

  let reviewId: number;

  try {
    const response = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      body,
      event,
      comments,
    });
    reviewId = response.data.id;
  } catch (error: unknown) {
    if (comments.length > 0 && shouldRetryWithoutInline(error)) {
      core.warning("GitHub rejected inline comments, retrying as single-line...");

      const singleLineComments = comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side as "RIGHT",
        body: c.body,
      }));

      try {
        const response = await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          body,
          event,
          comments: singleLineComments,
        });
        reviewId = response.data.id;
      } catch {
        core.warning("Single-line comments also rejected, posting summary only...");
        const response = await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          body: buildReviewBody(consolidated, new Set(), perspectiveNameMap),
          event,
        });
        reviewId = response.data.id;
      }
    } else {
      throw error;
    }
  }

  core.info(`Posted review #${reviewId}`);

  await dismissStaleReviews(octokit, owner, repo, pullNumber, reviewId);

  return reviewId;
}

function buildComments(
  consolidated: ConsolidatedReview,
  files: DiffFile[],
  maxComments: number,
  perspectiveNameMap: Map<string, string>,
): { comments: ReviewComment[]; postedFindings: Set<ReviewFinding> } {
  const comments: ReviewComment[] = [];
  const postedFindings = new Set<ReviewFinding>();

  for (const finding of consolidated.findings) {
    if (comments.length >= maxComments) {
      core.info(`Reached max-comments limit (${maxComments})`);
      break;
    }

    const diffFile = files.find((f) => f.filename === finding.file);
    if (!diffFile) {
      core.warning(`File not in diff: ${finding.file}`);
      continue;
    }

    if (!isLineInDiff(diffFile.patch, finding.line)) {
      core.warning(`Line ${finding.line} not in diff for ${finding.file}`);
      continue;
    }

    const comment: ReviewComment = {
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: formatCommentBody(finding, perspectiveNameMap),
    };

    const hasBalancedSuggestion = finding.suggestion && isSuggestionBalanced(finding.suggestion);

    if (hasBalancedSuggestion) {
      const startLine = finding.suggestionStartLine ?? calculateStartLine(finding);
      if (startLine && startLine < finding.line && isLineInDiff(diffFile.patch, startLine)) {
        comment.start_line = startLine;
        comment.start_side = "RIGHT";
      }
    }

    comments.push(comment);
    postedFindings.add(finding);
  }

  return { comments, postedFindings };
}

export function calculateStartLine(finding: ReviewFinding): number | undefined {
  if (!finding.suggestion) return undefined;
  const lineCount = finding.suggestion.split("\n").length;
  if (lineCount <= 1) return undefined;
  const startLine = finding.line - lineCount + 1;
  if (startLine < 1 || startLine >= finding.line) return undefined;
  return startLine;
}

export function formatCommentBody(
  finding: ReviewFinding,
  perspectiveNameMap: Map<string, string>,
): string {
  const severityBadge = severityBadgeMap[finding.severity];
  const confidenceIcon = confidenceIconMap[finding.confidence];

  const perspectiveNames = resolvePerspectiveNames(finding.foundBy, perspectiveNameMap);
  const attribution =
    perspectiveNames.length > 1
      ? `Found by: ${perspectiveNames.join(", ")}`
      : `Found by: **${perspectiveNames[0]}**`;

  const parts: string[] = [];
  parts.push(`${severityBadge} **Severity: ${finding.severity.toUpperCase()}**`);
  parts.push(`${confidenceIcon} **Confidence: ${finding.confidence}**`);
  parts.push("");
  parts.push(finding.description);

  if (finding.suggestion) {
    const balanced = isSuggestionBalanced(finding.suggestion);
    parts.push("");
    if (balanced) {
      parts.push("```suggestion");
    } else {
      core.warning(
        `Posting unbalanced suggestion as plain code block: ${finding.file}:${finding.line}`,
      );
      parts.push("```");
    }
    parts.push(finding.suggestion);
    parts.push("```");
  }

  parts.push("");
  parts.push(`— ${attribution}`);
  parts.push("");
  parts.push(`<!-- ${FINDING_ID_MARKER}:${finding.id} -->`);

  return parts.join("\n");
}

const severityBadgeMap: Record<string, string> = {
  high: "🔴",
  medium: "🟡",
  low: "🔵",
};

const confidenceIconMap: Record<string, string> = {
  high: "✅",
  medium: "⚠️",
  low: "❓",
};

export function buildReviewBody(
  consolidated: ConsolidatedReview,
  postedFindings: Set<ReviewFinding>,
  perspectiveNameMap: Map<string, string>,
  respectAuthorReplies: boolean = false,
  dismissedCount: number = 0,
): string {
  const parts: string[] = [];

  parts.push(`## ${REVIEW_SIGNATURE}`);
  parts.push("");

  const { stats } = consolidated;
  const statParts: string[] = [];
  if (stats.high > 0) statParts.push(`🔴 **${stats.high} High**`);
  if (stats.medium > 0) statParts.push(`🟡 **${stats.medium} Medium**`);
  if (stats.low > 0) statParts.push(`🔵 **${stats.low} Low**`);
  if (statParts.length === 0) statParts.push("✅ **No issues found**");
  parts.push(statParts.join(" · "));
  parts.push("");

  if (dismissedCount > 0) {
    parts.push(
      `✅ **${dismissedCount} finding${dismissedCount === 1 ? " was" : "s were"} dismissed** based on author replies from a previous review round.`,
    );
    parts.push("");
  }

  if (respectAuthorReplies && consolidated.findings.length > 0) {
    parts.push(
      '> 💬 **Disagree with a finding?** Reply to this comment or click "Resolve conversation" — the bot will dismiss it in the next review round.',
    );
    parts.push("");
  }

  if (consolidated.summary) {
    parts.push(consolidated.summary);
    parts.push("");
  }

  if (consolidated.perspectiveSummaries.length > 0) {
    parts.push("### 🏷️ Agent Breakdown");
    parts.push("");
    parts.push("| Perspective | High | Medium | Low | Total |");
    parts.push("|---|---|---|---|---|");
    for (const ps of consolidated.perspectiveSummaries) {
      parts.push(
        `| ${ps.perspectiveName} | ${ps.highCount} | ${ps.mediumCount} | ${ps.lowCount} | ${ps.findingCount} |`,
      );
    }
    parts.push("");
  }

  const posted = consolidated.findings.filter((f) => postedFindings.has(f));
  if (posted.length > 0) {
    parts.push("### 📋 Posted findings");
    parts.push("");
    parts.push("| # | Severity | Confidence | File | Line | Perspectives |");
    parts.push("|---|---|---|---|---|---|");
    for (let i = 0; i < posted.length; i++) {
      const f = posted[i];
      const sevBadge = severityBadgeMap[f.severity];
      const confIcon = confidenceIconMap[f.confidence];
      const shortFile = f.file.split("/").pop() ?? f.file;
      const perspNames = resolvePerspectiveNames(f.foundBy, perspectiveNameMap).join(", ");
      parts.push(
        `| **${i + 1}** | ${sevBadge} ${f.severity} | ${confIcon} ${f.confidence} | \`${shortFile}\` | ${f.line} | ${perspNames} |`,
      );
    }
    parts.push("");
  }

  const unposted = consolidated.findings.filter((f) => !postedFindings.has(f));
  if (unposted.length > 0) {
    parts.push("---");
    parts.push("### Findings not posted inline");
    parts.push("");
    for (let i = 0; i < unposted.length; i++) {
      const f = unposted[i];
      const sevBadge = severityBadgeMap[f.severity];
      const confIcon = confidenceIconMap[f.confidence];
      const perspNames = resolvePerspectiveNames(f.foundBy, perspectiveNameMap).join(", ");
      parts.push(
        `${sevBadge} **${i + 1}** — \`${f.file}:${f.line}\` · ${confIcon} ${f.confidence} · Found by: ${perspNames}`,
      );
      parts.push("");
      parts.push(f.description);
      if (f.suggestion) {
        parts.push("");
        parts.push("```suggestion");
        parts.push(f.suggestion);
        parts.push("```");
      }
      parts.push("");
    }
  }

  parts.push("---");
  parts.push(
    `*Batches: ${stats.totalBatches} · Perspectives: ${stats.totalPerspectives} · LLM calls: ${stats.successfulLLMCalls}/${stats.totalLLMCalls}*`,
  );
  parts.push("");
  parts.push("*[Livvie Code Review](https://github.com/4itworks/livvie_code_review)*");

  return parts.join("\n");
}

export function shouldRetryWithoutInline(error: unknown): boolean {
  const err = error as Record<string, unknown> | undefined;
  if (err?.status !== 422) return false;
  const response = err.response as Record<string, unknown> | undefined;
  const details = JSON.stringify(response?.data || err?.message || "");
  return /position|line|side|diff/i.test(details);
}

async function dismissStaleReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  currentReviewId: number,
): Promise<void> {
  try {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    for (const review of reviews) {
      if (
        review.id !== currentReviewId &&
        review.user?.type === "Bot" &&
        (review.body || "").includes(REVIEW_SIGNATURE)
      ) {
        try {
          if (review.state === "CHANGES_REQUESTED") {
            await octokit.rest.pulls.dismissReview({
              owner,
              repo,
              pull_number: pullNumber,
              review_id: review.id,
              message: "Superseded by a newer review.",
            });
            core.info(`Dismissed stale review #${review.id} (CHANGES_REQUESTED)`);
          } else if (review.state === "COMMENTED" || review.state === "APPROVED") {
            await deleteReviewComments(octokit, owner, repo, pullNumber, review.id);
            await updateReviewBody(octokit, owner, repo, pullNumber, review.id);
            core.info(`Cleaned up stale review #${review.id} (${review.state})`);
          }
        } catch (error) {
          core.warning(`Could not clean up stale review #${review.id}: ${error}`);
        }
      }
    }
  } catch (error) {
    core.warning(`Could not check for stale reviews: ${error}`);
  }
}

async function deleteReviewComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.pulls.listCommentsForReview, {
    owner,
    repo,
    pull_number: pullNumber,
    review_id: reviewId,
    per_page: 100,
  });

  for (const comment of comments) {
    try {
      await octokit.rest.pulls.deleteReviewComment({
        owner,
        repo,
        comment_id: comment.id,
      });
    } catch (error) {
      core.warning(`Could not delete comment ${comment.id}: ${error}`);
    }
  }
}

async function updateReviewBody(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
): Promise<void> {
  try {
    await octokit.rest.pulls.updateReview({
      owner,
      repo,
      pull_number: pullNumber,
      review_id: reviewId,
      body: `*Superseded by a newer review. Inline comments have been removed.*`,
    });
  } catch (error) {
    core.warning(`Could not update review body #${reviewId}: ${error}`);
  }
}
