# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `hotfix-labels` and `hotfix-keywords` inputs to automatically soften the review focus for urgent bugfixes.
- Scope hints are injected into review instructions when a PR is identified as a hotfix/urgent bugfix.
- Fuzzy matching for dismissal signals when a finding ID changes between review rounds.
- Dismissed findings count is shown in the review body when dismissal signals are present.

### Changed
- `respect-author-replies` now defaults to `true`.
- Finding IDs are now generated from normalized descriptions, making them stable across LLM rephrasings.
- Review agents (generalist, security, performance, architecture, code-quality) now include explicit scope-discipline guidance.
- Replaced LLM-based reply evaluation with dismissal signals: resolved GitHub review threads and any non-empty author reply now dismiss the finding automatically.

## [1.0.0] - 2026-07-10

### Added
- Multi-perspective specialist reviewers (code-quality, security, performance, architecture, generalist)
- Batching for large PRs with bin-packing by token budget
- Native GitHub suggestion blocks for one-click code fixes
- REQUEST_CHANGES on high-severity findings (configurable)
- APPROVE for zero-findings PRs
- Inline comments on exact diff lines
- Perspective attribution and deduplication
- Circuit breaker with fallback model support and half-open recovery (30s cooldown)
- Progressive file truncation (full → window-10 → window-5 → diff-only)
- Cross-file context between batches
- Stale review dismissal
- Configurable ignore patterns for generated files
- Verbose mode for LLM reasoning traces (`verbose` input)
- Action outputs: `review-id`, `finding-count`
- CI pipeline: typecheck + test + build verification (gate for merge)
- 209 unit tests (vitest) covering 12 source modules

### Fixed
- Circuit breaker now recovers after 30s cooldown (was permanently open)
- Glob patterns now anchored with `^...$` (was over-matching)
- Deduplication now considers description similarity (was proximity-only)
- Batch overflow logged when exceeding 2× token budget
- File content fetch errors now logged instead of silently swallowed

### Changed
- Default ignore patterns are now language-agnostic (`build/**,dist/**,node_modules/**`)
- Unbalanced suggestions use generic code fence instead of hardcoded `dart`
- Removed dead code: `reviewWithLLM()`, `buildUserMessage()`, `extractDiffHunks()`, `withTimeout()`, `countPromptTokens()`
- Removed unused exports: `DEFAULT_IGNORE_PATTERNS`, `DEFAULT_PERSPECTIVES`
- Removed dead files: `prompts/review-system.md`, `.nccrc.json`
- Runtime: `node24` → `node20` for broader runner compatibility
- All `var` declarations replaced with `let`/`const`

### Security
- API keys masked with `core.setSecret()` to prevent log leakage
- Error messages sanitized (Bearer tokens redacted, truncated to 500 chars)
- Fetch timeout (120s) on LLM calls via AbortController
- Input validation on all numeric parameters (NaN/negative guard)
- Reasoning traces gated behind `verbose` flag (default off)
