/** Review submission event policy for postReview. */
export type SubmitAs = "auto" | "approve" | "comment";

export interface DiffFile {
  filename: string;
  patch: string;
  additions: number;
  deletions: number;
  status?: "added" | "modified" | "removed" | "renamed";
}

export interface ReviewFinding {
  id: string;
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  file: string;
  line: number;
  description: string;
  suggestion: string | null;
  suggestionStartLine: number | null;
  perspective: string;
  foundBy: string[];
}

export interface StructuredReview {
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
}

export interface Perspective {
  id: string;
  name: string;
  systemPrompt: string;
  focus: string;
}

export interface AgentModelOverrides {
  model: string | null;
  temperature: number;
}

export interface PreparedFile {
  filename: string;
  patch: string;
  additions: number;
  deletions: number;
  content: string;
  tokenCount: number;
  truncated: boolean;
  directory: string;
}

export interface Batch {
  index: number;
  files: PreparedFile[];
  tokenCount: number;
  crossFileContext: string;
  totalTokenCount: number;
}

export interface BatchReviewResult {
  batchIndex: number;
  perspectiveId: string;
  perspectiveName: string;
  review: StructuredReview;
  modelUsed: string;
  latencyMs: number;
  usedFallback: boolean;
  error?: string;
}

export interface ReviewMatrixResult {
  results: BatchReviewResult[];
  rawFindings: ReviewFinding[];
  failedBatches: number[];
  unreviewedFiles: string[];
  totalCalls: number;
  successfulCalls: number;
}

export interface ConsolidatedReview {
  summary: string;
  findings: ReviewFinding[];
  perspectiveSummaries: PerspectiveSummary[];
  unreviewedFiles: string[];
  stats: ReviewStats;
}

export interface PerspectiveSummary {
  perspectiveId: string;
  perspectiveName: string;
  findingCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  summary: string;
}

export interface ReviewStats {
  totalFindings: number;
  high: number;
  medium: number;
  low: number;
  totalBatches: number;
  totalPerspectives: number;
  totalLLMCalls: number;
  successfulLLMCalls: number;
  failedBatches: number;
}

export interface PipelineConfig {
  githubToken: string;
  owner: string;
  repo: string;
  pullNumber: number;
  prHeadRef: string;
  prBaseRef: string;
  prAuthorLogin: string;
  llmApiKey: string;
  llmBaseUrl: string;
  model: string;
  fallbackModel: string;
  maxOutputTokens: number;
  reasoningEffort: string;
  maxDiffSize: number;
  maxBatches: number;
  contextWindow: number;
  ignorePatterns: string[];
  diffContextLines: number;
  agentsDir: string;
  agentModelOverrides: Map<string, AgentModelOverrides>;
  reviewInstructions: string;
  includeSeverities: Set<"low" | "medium" | "high">;
  includeConfidences: Set<"low" | "medium" | "high">;
  requestChangesOn: Set<"low" | "medium" | "high">;
  maxComments: number;
  respectAuthorReplies: boolean;
  submitAs: SubmitAs;
  selfAuthored: boolean;
  fetchConcurrency: number;
  llmConcurrency: number;
  safetyMargin: number;
  crossFileBudgetRatio: number;
  crossFileBudgetMax: number;
  circuitBreakerThreshold: number;
}

export interface TokenBudget {
  contextWindow: number;
  maxOutput: number;
  systemPromptTokens: number;
  reviewInstructionsTokens: number;
  crossFileHunksTokens: number;
  safetyMargin: number;
  fileBudget: number;
}

export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  threshold: number;
}

export interface Semaphore {
  acquire(): Promise<() => void>;
  get available(): number;
  get waiting(): number;
}
