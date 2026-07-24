import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import type { ReviewFinding } from "./types.js";
import { FINDING_ID_MARKER } from "./post.js";

const LLM_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_TEMPERATURE = 0.1;
const MIN_CONTENT_LENGTH = 5;

export interface AuthorReply {
  findingId: string;
  replyBody: string;
  replyAuthor: string;
  originalCommentId: number;
  replyCommentId: number;
}

export interface DismissedFinding {
  findingId: string;
  reason: string;
}

export interface ReplyEvaluationConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
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

      replies.push({
        findingId,
        replyBody: comment.body || "",
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

export async function evaluateAuthorReplies(
  findings: ReviewFinding[],
  replies: AuthorReply[],
  config: ReplyEvaluationConfig,
): Promise<DismissedFinding[]> {
  if (replies.length === 0) return [];

  const findingById = new Map(findings.map((f) => [f.id, f]));
  const repliesByFindingId = groupByFindingId(replies);
  const dismissed: DismissedFinding[] = [];

  for (const [findingId, findingReplies] of repliesByFindingId.entries()) {
    let finding = findingById.get(findingId);
    if (!finding) {
      finding = findFindingByReplyFuzzy(findings, findingId, findingReplies);
    }
    if (!finding) {
      core.info(`Reply references unknown finding ${findingId}, skipping`);
      continue;
    }

    const combinedReply = findingReplies
      .map((r) => `**${r.replyAuthor}:** ${r.replyBody}`)
      .join("\n\n");

    try {
      const evaluation = await evaluateReply(finding, combinedReply, config);
      if (evaluation.accepted) {
        dismissed.push({ findingId: finding.id, reason: evaluation.reason });
        core.info(
          `Finding ${finding.file}:${finding.line} dismissed by author reply: ${evaluation.reason}`,
        );
      } else {
        core.info(
          `Finding ${finding.file}:${finding.line} reply not accepted: ${evaluation.reason}`,
        );
      }
    } catch (error) {
      core.warning(`Could not evaluate reply for finding ${findingId}: ${error}`);
    }
  }

  return dismissed;
}

function findFindingByReplyFuzzy(
  findings: ReviewFinding[],
  originalFindingId: string,
  replies: AuthorReply[],
): ReviewFinding | undefined {
  if (findings.length === 0) return undefined;

  const replyBody = replies
    .map((r) => r.replyBody)
    .join(" ")
    .toLowerCase();

  for (const finding of findings) {
    const bodyHasFile = replyBody.includes(finding.file.toLowerCase().split("/").pop() || "");
    if (!bodyHasFile) continue;

    const bodyHasLine =
      replyBody.includes(`:${finding.line}`) || replyBody.includes(` ${finding.line} `);
    if (!bodyHasLine) continue;

    return finding;
  }

  const originalFileLine = extractFileLineFromFindingId(originalFindingId, findings);
  if (originalFileLine) {
    const candidates = findings.filter(
      (f) => f.file === originalFileLine.file && Math.abs(f.line - originalFileLine.line) <= 3,
    );
    if (candidates.length === 1) {
      return candidates[0];
    }
  }

  return undefined;
}

function extractFileLineFromFindingId(
  findingId: string,
  findings: ReviewFinding[],
): { file: string; line: number } | undefined {
  for (const finding of findings) {
    if (finding.id === findingId) {
      return { file: finding.file, line: finding.line };
    }
  }
  return undefined;
}

function groupByFindingId(replies: AuthorReply[]): Map<string, AuthorReply[]> {
  const map = new Map<string, AuthorReply[]>();
  for (const reply of replies) {
    const list = map.get(reply.findingId) ?? [];
    list.push(reply);
    map.set(reply.findingId, list);
  }
  return map;
}

interface ReplyEvaluation {
  accepted: boolean;
  reason: string;
}

async function evaluateReply(
  finding: ReviewFinding,
  replyBody: string,
  config: ReplyEvaluationConfig,
): Promise<ReplyEvaluation> {
  const systemPrompt = `You are a fair and experienced code reviewer. Your job is to evaluate whether an author's response to a requested code change is reasonable and sufficient to dismiss the finding.

Be pragmatic. Accept the response if any of the following is true:
- The requested change is outside the scope of the PR.
- The flagged code is a pre-existing shared component and the PR does not meaningfully modify it.
- The PR is an urgent bugfix or hotfix and the requested change would require refactoring unrelated code.
- The author explains that the issue is already handled elsewhere, does not apply in this context, or is a known accepted pattern.
- The author commits to addressing the finding in a follow-up PR with a reasonable justification and timeline.

Reject the response if it is evasive, incomplete, technically incorrect, or does not actually address the issue.

Respond ONLY with a JSON object matching this schema:

\`\`\`json
{
  "accepted": true,
  "reason": "One-sentence explanation of why the response is or is not reasonable"
}
\`\`\``;

  const userContent = `## Original finding

- **Severity:** ${finding.severity}
- **Confidence:** ${finding.confidence}
- **File:** ${finding.file}:${finding.line}
- **Description:** ${finding.description}
${finding.suggestion ? `- **Suggested change:**\n\`\`\`\n${finding.suggestion}\n\`\`\`` : ""}

## Author's response

${replyBody}

## Your evaluation

Is the author's response reasonable enough that this requested change should NOT be re-requested in the next review round? Respond with JSON only.`;

  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: DEFAULT_TEMPERATURE,
    max_tokens: Math.min(config.maxOutputTokens, 1000),
    response_format: { type: "json_object" },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "HTTP-Referer": "https://github.com/4itworks/livvie_code_review",
        "X-Title": "livvie-code-review",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";

    if (content.length < MIN_CONTENT_LENGTH) {
      throw new Error("LLM returned empty/short evaluation response");
    }

    const parsed = JSON.parse(content) as Partial<ReplyEvaluation>;
    return {
      accepted: parsed.accepted === true,
      reason:
        typeof parsed.reason === "string" && parsed.reason.length > 0
          ? parsed.reason
          : "No reason provided",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function filterDismissedFindings(
  findings: ReviewFinding[],
  dismissed: DismissedFinding[],
): { kept: ReviewFinding[]; dismissed: DismissedFinding[] } {
  const dismissedIds = new Set(dismissed.map((d) => d.findingId));
  const kept = findings.filter((f) => !dismissedIds.has(f.id));
  return { kept, dismissed };
}
