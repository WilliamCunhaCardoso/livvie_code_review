import * as core from "@actions/core";
import type { StructuredReview, ReviewFinding } from "./types.js";
import { validateSuggestion } from "./suggestion.js";

const VALID_SEVERITIES = new Set<"high" | "medium" | "low">(["high", "medium", "low"]);
const VALID_CONFIDENCES = new Set<"high" | "medium" | "low">(["high", "medium", "low"]);

export function parseReview(content: string, perspectiveId: string): StructuredReview {
  const trimmed = content.trim();
  if (!trimmed) {
    return { summary: "", findings: [] };
  }

  let parsed: unknown | undefined;
  let parseError: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    parseError = error;
  }

  if (parsed === undefined) {
    const extracted = extractJson(trimmed);
    if (extracted) {
      try {
        parsed = JSON.parse(extracted);
      } catch (error) {
        parseError = error;
      }
    }
  }

  if (parsed === undefined) {
    core.warning(
      `Could not parse JSON from LLM response (${content.length} chars). Attempting repair...`,
    );
    const repaired = attemptJsonRepair(trimmed);
    if (repaired) {
      core.info("Successfully repaired JSON from raw text response.");
      try {
        parsed = JSON.parse(repaired);
      } catch (error) {
        parseError = error;
        core.warning(`Repaired JSON parse failed: ${error}`);
      }
    }
  }

  if (parsed === undefined) {
    core.warning(`Failed to parse JSON review: ${parseError}`);
    return { summary: content.slice(0, 500), findings: [] };
  }

  const obj = parsed as Record<string, unknown>;
  const findings = Array.isArray(obj.findings) ? obj.findings : [];
  return {
    summary: typeof obj.summary === "string" ? obj.summary : "",
    findings: findings
      .map((f) => normalizeFinding(f as Record<string, unknown>, perspectiveId))
      .filter(isValidFinding),
  };
}

function attemptJsonRepair(content: string): string | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    const candidate = repairJsonFragment(fenced[1].trim());
    if (candidate) return candidate;
  }

  const balanced = extractBalancedJson(content);
  if (balanced) {
    const candidate = repairJsonFragment(balanced);
    if (candidate) return candidate;
  }

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const candidate = repairJsonFragment(content.slice(start, end + 1).trim());
    if (candidate) return candidate;
  }

  return null;
}

function repairJsonFragment(fragment: string): string | null {
  const trimmed = fragment.trim();
  if (!trimmed) return null;

  let candidate = fixTrailingCommas(trimmed);
  candidate = fixUnclosedBraces(candidate);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function fixTrailingCommas(json: string): string {
  const result: string[] = [];
  let i = 0;
  const len = json.length;

  while (i < len) {
    const state = getStringState(json, i);
    if (state.inString || state.inBlockComment || state.inLineComment) {
      result.push(json[i]);
      i++;
      continue;
    }

    if (json[i] === ",") {
      const nextNonSpace = findNextNonSpace(json, i + 1);
      if (nextNonSpace !== -1 && (json[nextNonSpace] === "}" || json[nextNonSpace] === "]")) {
        i++;
        continue;
      }
    }

    result.push(json[i]);
    i++;
  }

  return result.join("");
}

function fixUnclosedBraces(json: string): string {
  let opens = 0;
  let brackets = 0;
  let i = 0;
  const len = json.length;

  while (i < len) {
    const state = getStringState(json, i);
    if (state.inString || state.inBlockComment || state.inLineComment) {
      i = state.endIndex;
      continue;
    }

    if (json[i] === "{") opens++;
    else if (json[i] === "}") opens--;
    else if (json[i] === "[") brackets++;
    else if (json[i] === "]") brackets--;
    i++;
  }

  let fixed = json;
  if (opens > 0) fixed += "}".repeat(opens);
  if (brackets > 0) fixed += "]".repeat(brackets);
  return fixed;
}

function extractJson(content: string): string | null {
  const trimmed = content.trim();

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through to extraction
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    const candidate = fenced[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // fall through
    }
  }

  const balanced = extractBalancedJson(trimmed);
  if (balanced) {
    try {
      JSON.parse(balanced);
      return balanced;
    } catch {
      // fall through
    }
  }

  return null;
}

function extractBalancedJson(content: string): string | null {
  let i = 0;
  const len = content.length;

  while (i < len) {
    if (content[i] === "{") {
      let depth = 0;
      let j = i;
      while (j < len) {
        const state = getStringState(content, j);
        if (state.inString || state.inBlockComment || state.inLineComment) {
          j = state.endIndex;
          continue;
        }

        if (content[j] === "{") depth++;
        else if (content[j] === "}") depth--;

        if (depth === 0) {
          return content.slice(i, j + 1);
        }
        j++;
      }
    }
    i++;
  }

  return null;
}

interface StringState {
  inString: boolean;
  inBlockComment: boolean;
  inLineComment: boolean;
  endIndex: number;
}

function getStringState(text: string, startIndex: number): StringState {
  let i = 0;
  const len = text.length;

  while (i < len) {
    if (i >= startIndex) {
      return {
        inString: false,
        inBlockComment: false,
        inLineComment: false,
        endIndex: i + 1,
      };
    }

    if (text[i] === "\\") {
      i += 2;
      continue;
    }

    if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const quote = text[i];
      i++;
      while (i < len) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < len && text[i] !== "\n") i++;
      continue;
    }

    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < len && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    i++;
  }

  return {
    inString: false,
    inBlockComment: false,
    inLineComment: false,
    endIndex: len,
  };
}

function findNextNonSpace(text: string, startIndex: number): number {
  for (let i = startIndex; i < text.length; i++) {
    if (!/\s/.test(text[i])) return i;
  }
  return -1;
}

export function normalizeFinding(
  raw: Record<string, unknown>,
  perspectiveId: string,
): ReviewFinding {
  const hasSuggestion = raw.suggestion && String(raw.suggestion).trim().length > 0;
  const lineValue = Number(raw.line);
  const line = Number.isFinite(lineValue) && lineValue > 0 ? lineValue : 0;
  const suggestionStartLineRaw = Number(raw.suggestion_start_line);
  const suggestionStartLine =
    hasSuggestion &&
    Number.isFinite(suggestionStartLineRaw) &&
    suggestionStartLineRaw > 0 &&
    suggestionStartLineRaw < line
      ? suggestionStartLineRaw
      : null;

  const severity = VALID_SEVERITIES.has(raw.severity as "high" | "medium" | "low")
    ? (raw.severity as "high" | "medium" | "low")
    : "low";

  const confidence = VALID_CONFIDENCES.has(raw.confidence as "high" | "medium" | "low")
    ? (raw.confidence as "high" | "medium" | "low")
    : "medium";

  const file = String(raw.file || "").trim();
  const description = String(raw.description || "").trim();

  const normalized: ReviewFinding = {
    id: generateFindingId(file, line, description),
    severity,
    confidence,
    file,
    line,
    description,
    suggestion: hasSuggestion ? String(raw.suggestion).trim() : null,
    suggestionStartLine,
    perspective: perspectiveId,
    foundBy: [perspectiveId],
  };

  return validateSuggestion(normalized);
}

export function generateFindingId(file: string, line: number, description: string): string {
  const normalized = `${file}:${line}:${normalizeFindingDescription(description)}`;
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash << 5) + hash + normalized.charCodeAt(i);
  }
  return Math.abs(hash).toString(36).slice(0, 12);
}

export function normalizeFindingDescription(description: string): string {
  const stopWords = new Set([
    // English
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "shall",
    "can",
    "need",
    "dare",
    "ought",
    "used",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "over",
    "under",
    "and",
    "but",
    "or",
    "yet",
    "so",
    "if",
    "because",
    "although",
    "though",
    "while",
    "where",
    "when",
    "that",
    "which",
    "who",
    "whom",
    "whose",
    "what",
    "this",
    "these",
    "those",
    "it",
    "its",
    "it's",
    "they",
    "them",
    "their",
    "there",
    "then",
    "than",
    "also",
    "only",
    "just",
    "even",
    "still",
    "already",
    "yet",
    "too",
    "very",
    "really",
    "quite",
    "rather",
    "such",
    "here",
    "now",
    "how",
    "why",
    "all",
    "any",
    "both",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "no",
    "nor",
    "not",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "without",
    "within",
    "across",
    "around",
    "behind",
    "beyond",
    "except",
    "including",
    // Portuguese
    "o",
    "a",
    "os",
    "as",
    "um",
    "uma",
    "uns",
    "umas",
    "de",
    "do",
    "da",
    "dos",
    "das",
    "em",
    "no",
    "na",
    "nos",
    "nas",
    "por",
    "para",
    "pró",
    "pro",
    "pra",
    "pelo",
    "pela",
    "pelos",
    "pelas",
    "com",
    "sem",
    "sob",
    "sobre",
    "ante",
    "após",
    "até",
    "como",
    "conforme",
    "contra",
    "desde",
    "entre",
    "perante",
    "salvo",
    "segundo",
    "trás",
    "mediante",
    "exceto",
    "durante",
    "e",
    "ou",
    "mas",
    "porém",
    "todavia",
    "contudo",
    "entretanto",
    "logo",
    "pois",
    "porque",
    "porquanto",
    "já",
    "que",
    "se",
    "quando",
    "enquanto",
    "embora",
    "conquanto",
    "assim",
    "não",
    "foi",
    "são",
    "era",
    "ser",
    "estar",
    "está",
    "estão",
    "esteve",
    "estiveram",
    "este",
    "esta",
    "estes",
    "estas",
    "esse",
    "essa",
    "esses",
    "essas",
    "aquele",
    "aquela",
    "aqueles",
    "aquelas",
    "isto",
    "isso",
    "aquilo",
    "eu",
    "tu",
    "ele",
    "ela",
    "nós",
    "vós",
    "eles",
    "elas",
    "me",
    "te",
    "se",
    "nos",
    "vos",
    "lhe",
    "lhes",
    "meu",
    "minha",
    "meus",
    "minhas",
    "teu",
    "tua",
    "teus",
    "tuas",
    "seu",
    "sua",
    "seus",
    "suas",
    "nosso",
    "nossa",
    "nossos",
    "nossas",
    "muito",
    "pouco",
    "mais",
    "menos",
    "bem",
    "mal",
    "tão",
    "tanto",
    "quase",
    "apenas",
    "somente",
    "mesmo",
    "próprio",
    "tal",
    "tão",
    "todo",
    "toda",
    "todos",
    "todas",
    "cada",
    "qualquer",
    "outro",
    "outra",
    "outros",
    "outras",
    "algo",
    "alguém",
    "nada",
    "ninguém",
    "tudo",
    "cá",
    "lá",
    "aqui",
    "aí",
    "ali",
    "onde",
    "aonde",
    "quanto",
    "pr",
    "mr",
    "mrs",
    "ms",
    "dr",
  ]);

  return description
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !stopWords.has(word))
    .sort()
    .join(" ");
}

export function isValidFinding(f: ReviewFinding): boolean {
  return (
    f.file.length > 0 &&
    f.line > 0 &&
    f.description.length > 0 &&
    f.perspective.length > 0 &&
    f.foundBy.length > 0
  );
}
