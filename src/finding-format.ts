export const FINDING_ID_MARKER = "livvie:finding-id";

export function extractFindingId(body: string): string | null {
  const match = body.match(new RegExp(`<!--\\s*${FINDING_ID_MARKER}:([a-zA-Z0-9]+)\\s*-->`));
  return match?.[1] ?? null;
}
