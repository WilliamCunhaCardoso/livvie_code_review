export function parseHotfixList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

export interface PullRequestContext {
  title: string;
  body: string;
  labels: string[];
}

export function isHotfix(
  context: PullRequestContext,
  labels: string[],
  keywords: string[],
): boolean {
  const normalizedTitle = context.title.toLowerCase();
  const normalizedBody = context.body.toLowerCase();

  for (const label of context.labels) {
    if (labels.includes(label.toLowerCase())) {
      return true;
    }
  }

  for (const keyword of keywords) {
    if (normalizedTitle.includes(keyword) || normalizedBody.includes(keyword)) {
      return true;
    }
  }

  return false;
}

export function buildScopeHint(
  context: PullRequestContext,
  labels: string[],
  keywords: string[],
): string {
  if (!isHotfix(context, labels, keywords)) {
    return "";
  }

  return `## PR scope hint

This PR is flagged as an urgent bugfix or hotfix. Focus your review strictly on:
- Regressions introduced by the change
- Security issues that this change creates or exposes
- Bugs directly caused by the modified code paths

Do NOT request refactoring of pre-existing shared components, style changes, or architectural improvements that are outside the immediate scope of the fix. If a shared component is touched only incidentally, evaluate the bugfix logic, not the component's existing patterns.`;
}
