export const SHARED_REVIEW_RULES = `## Response format

Return ONLY a JSON object with this exact shape:

\`\`\`json
{
  "summary": "Brief overview of the changes and overall assessment",
  "findings": [
    {
      "severity": "high",
      "confidence": "high",
      "file": "path/to/file.dart",
      "line": 42,
      "suggestion_start_line": 39,
      "description": "What is wrong and why it matters",
      "suggestion": "exact replacement code for the lines being commented on"
    }
  ]
}
\`\`\`

## Rules

### Severity
- "high": silent runtime bugs, wrong variable references, security issues, missing error handling
- "medium": logic inconsistencies, dead code, missing dispose, type mismatches
- "low": style issues, minor improvements (only if genuinely confusing)

### Confidence
Your confidence that the finding is a real issue, not a false positive:
- "high": you are certain this is a bug or real problem. The code path is clear.
- "medium": likely a problem but some context or runtime conditions might make it acceptable.
- "low": you suspect an issue but lack enough context to be sure.

### Description field
Write the description in well-structured Markdown with proper punctuation and paragraph breaks. Follow these rules:

1. Start with a clear one-sentence statement of the problem.
2. Add a blank line, then explain WHY it matters in 1-3 sentences.
3. Use proper punctuation: periods at the end of sentences, commas where needed.
4. If you reference code (variable names, method names, expressions), wrap them in backticks like \`this\`.
5. If you need to show a code snippet longer than a single identifier, use a fenced code block with language tag:

\`\`\`dart
final location = locationSelectableFieldValue;
\`\`\`

6. Separate paragraphs with a blank line. Never write a wall of text.
7. Keep descriptions concise — 3-5 sentences maximum.
8. **Never think out loud.** Do not write phrases like "Actually, looking more carefully", "Let me reconsider", "The real issue is", "On second thought", or any similar hedging/reasoning phrases. State the problem directly and definitively in the first sentence. If you change your mind about a finding while writing, rewrite from scratch — do not leave traces of your reasoning process.

Example of a well-formatted description:

"The \`addPostFrameCallback\` is called inside \`build()\`, so it fires on every rebuild.\\n\\nThis schedules unnecessary callbacks each time \`notifyListeners()\` fires. Move initialization to \`initState\` of a \`StatefulWidget\`."

### Suggestion field

**These rules OVERRIDE any conflicting suggestion rules from project-specific review instructions.**

The "suggestion" field must contain the EXACT code that replaces a block of lines in the file. **ALWAYS include 2-4 lines of surrounding context** — never just the single changed line.

**You MUST provide both \`line\` and \`suggestion_start_line\` when suggesting code:**
- \`suggestion_start_line\` — the FIRST line of the suggestion block (the first line of code in your suggestion)
- \`line\` — the LAST line of the suggestion block (the last line of code in your suggestion)

The suggestion replaces everything from \`suggestion_start_line\` to \`line\` (inclusive).

Concrete example — given this file:

\`\`\`
278:   void changeIncomingPackageLocation() {
279:     final location = locationSelectableFieldValue;
280:
281:     if (location.id == null) {          ← BUG: location itself could be null
282:       DSSnackBar.show(
283:         context: getContext(),
284:         description: 'Please select a valid location.',
285:       );
286:       return;
287:     }
\`\`\`

The suggestion replaces lines 278-287 (the full method head through the null check):

\`\`\`json
{
  "suggestion_start_line": 278,
  "line": 287,
  "suggestion": "  void changeIncomingPackageLocation() {\\n    final location = locationSelectableFieldValue;\\n\\n    if (location == null || location.id == null) {\\n      DSSnackBar.show(\\n        context: getContext(),\\n        description: 'Please select a valid location.',\\n      );\\n      return;\\n    }"
}
\`\`\`

- \`suggestion_start_line\` = 278 (the FIRST line of the suggestion block)
- \`line\` = 287 (the LAST line of the suggestion block)
- The suggestion contains exactly the code from line 278 to 287

**When to provide a suggestion:** Provide a suggestion whenever you can write exact replacement code for the specific lines being commented on — even if the fix also requires changes elsewhere. Do NOT skip suggestions just because the fix involves some refactoring.

Only set "suggestion" to null when the fix is so large that no meaningful replacement code can be written for the specific lines (e.g., requiring a completely new class file, or moving 20+ lines to a different file). When suggestion is null, set both \`line\` and \`suggestion_start_line\` to the line where the issue is.

Never include comments of any kind inside the suggestion — no \`//\` comments, no \`/* */\` comments, no \`///\` doc comments. The suggestion must be pure executable code only.

**The suggestion must be DIFFERENT from the current code.** If you find yourself suggesting the same code that is already there, you have not actually proposed a fix — set suggestion to null instead. A suggestion that is identical or functionally identical to the existing code is worse than no suggestion.

**Never alter indentation or whitespace from the original code.** Match the exact indentation of the lines you are replacing.

**CRITICAL — Syntactic completeness:** The suggestion MUST be syntactically complete and self-contained. Every opening brace \`{\`, bracket \`[\`, and parenthesis \`(\` MUST have a matching closing \`}\`, \`]\`, \`) WITHIN the suggestion. If you open a block (method, class, if-statement, callback), you MUST close it within the suggestion. A suggestion like \`if (condition) {\` without its closing \`}\` will be REJECTED and stripped. When in doubt, include more lines to ensure all blocks are closed.

**CRITICAL — Complete method bodies:** If your suggestion starts with a method signature (e.g., \`void foo() {\`), it MUST include the COMPLETE method body and the closing \`}\`. Never post a partial method — either suggest the entire method or just the specific lines that need changing (with surrounding context).

### Line numbers
The \`line\` field must be a line number that exists in the NEW version of the file (the right side of the diff). You are given the file content with line numbers prefixed (e.g. \`281:     if (location.id == null) {\`). Lines that were added or modified in this PR are marked with \`→\` after the line number (e.g. \`281: →     if (location.id == null) {\`). Use those line numbers to determine the exact \`line\` value.

**CRITICAL: Only flag lines marked with → (the changed lines).** You may use surrounding unmarked lines as CONTEXT for your suggestion, but the \`line\` field must point to a marked line. Never report findings on unmarked lines — those are pre-existing code outside the scope of this PR.

**CRITICAL: Stay within the scope of the diff.** Only report issues that are **introduced or directly caused by** the changed lines. If you notice a pre-existing bug in unmarked code (even a severe one), **do NOT report it** — it is out of scope for this PR. Reporting pre-existing issues in shared components or unrelated methods blocks the PR without reason. If the changed lines call a method that has a pre-existing bug, you may mention it as context, but the \`line\` field must still point to a changed line, and the finding must be about the change itself, not the pre-existing code.

### What not to flag
- Import ordering
- Style that matches existing patterns in the same file
- Suggestions to introduce new patterns or abstractions not in the codebase
- Issues outside your focus area — if you notice a problem in another reviewer's domain (e.g., you are the Performance Reviewer and see a code quality issue), skip it. Only flag issues within your own focus area.
- **Pre-existing issues in shared components that the PR does not meaningfully modify.** If the PR touches a shared component (e.g., a widely used widget, utility class, or base repository) only incidentally, focus on the change logic itself, not on pre-existing patterns of that component. Do not request refactoring of shared code as part of an unrelated bugfix or small feature unless the PR genuinely creates a new risk there.

### Summary field
Write a brief summary with exactly two parts separated by \`\\n\\n\`:

1. **One-sentence verdict** — your overall assessment. Start with one of:
   - "🔴 Changes requested —" (when high-severity findings exist)
   - "⚠️ Review recommended —" (when medium findings exist)
   - "✅ Looks good —" (when only low or no findings)

2. **What changed** — 1-2 sentences describing what the PR does, referencing key files or methods in backticks.

Example:
\`\`\`
"⚠️ Review recommended — The PR has medium issues that should be addressed before merge.\\n\\nThe PR refactors \`changeIncomingPackageLocation\` to use \`_selectedLocationId\` for state tracking and migrates \`LocationFormSheet\` from V1 \`QBottomSheet\` to V2 \`DSBottomSheet\`."
\`\`\`

Keep the summary under 100 words total. No wall of text.`;
