// Shared extended-grapheme-cluster witnesses for chunker regression tests.
//
// Every cluster below is one grapheme under Intl.Segmenter. `cut` is how many UTF-16 units
// into the cluster a naive hard cut lands; none of these cuts splits a surrogate pair, so a
// surrogate-only clamp leaves the cluster divided across two chunks.

export type GraphemeWitness = {
  name: string;
  cluster: string;
  cut: number;
};

export const FAMILY_EMOJI = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";

export const GRAPHEME_WITNESSES: readonly GraphemeWitness[] = [
  { name: "family ZWJ sequence", cluster: FAMILY_EMOJI, cut: 2 },
  { name: "regional indicator flag", cluster: "\u{1F1FA}\u{1F1F8}", cut: 2 },
  { name: "skin tone modifier", cluster: "\u{1F44D}\u{1F3FD}", cut: 2 },
  { name: "base plus combining mark", cluster: "e\u0301", cut: 1 },
  { name: "Indic conjunct with vowel sign", cluster: "\u0915\u094D\u0937\u093F", cut: 2 },
];

/** The issue's witness shape: an ASCII run that leaves `limit` exactly `cut` units inside the cluster. */
export function buildGraphemeCutWitness(witness: GraphemeWitness, limit: number): string {
  return `${"a".repeat(limit - witness.cut)}${witness.cluster}Z`;
}

/** A single cluster wider than the whole limit: the cutter must still advance and stay surrogate-safe. */
export const OVERSIZED_GRAPHEME_TEXT = `${FAMILY_EMOJI}${FAMILY_EMOJI}`;
export const OVERSIZED_GRAPHEME_LIMIT = 4;

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeBoundaryOffsets(text: string): Set<number> {
  const offsets = new Set<number>([0]);
  for (const { index, segment } of GRAPHEME_SEGMENTER.segment(text)) {
    offsets.add(index + segment.length);
  }
  return offsets;
}

/** With the `u` flag a surrogate range only matches halves that are not part of a valid pair. */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDFFF]/u.test(text);
}

/**
 * One line per violated invariant, so a failing `toEqual([])` names the exact chunk and offset.
 * Chunkers may drop separator whitespace between chunks, so each chunk is located in order.
 */
export function findGraphemeChunkViolations(
  text: string,
  chunks: readonly string[],
  limit: number,
): string[] {
  const boundaries = graphemeBoundaryOffsets(text);
  const violations: string[] = [];
  let cursor = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.length > limit) {
      violations.push(`chunk ${index} is ${chunk.length} units, over the limit of ${limit}`);
    }
    const start = text.indexOf(chunk, cursor);
    if (start < 0) {
      violations.push(`chunk ${index} is not found in the input after offset ${cursor}`);
      continue;
    }
    const end = start + chunk.length;
    if (!boundaries.has(start)) {
      violations.push(`chunk ${index} starts inside a grapheme at offset ${start}`);
    }
    if (!boundaries.has(end)) {
      violations.push(`chunk ${index} ends inside a grapheme at offset ${end}`);
    }
    cursor = end;
  }
  return violations;
}

/** Bounded progress on an oversized cluster: every unit is emitted, capped, and surrogate-safe. */
export function findOversizedGraphemeViolations(
  chunks: readonly string[],
  limit: number,
): string[] {
  const violations: string[] = [];
  if (chunks.join("") !== OVERSIZED_GRAPHEME_TEXT) {
    violations.push("chunks do not concatenate back to the input");
  }
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.length > limit) {
      violations.push(`chunk ${index} is ${chunk.length} units, over the limit of ${limit}`);
    }
    if (hasLoneSurrogate(chunk)) {
      violations.push(`chunk ${index} contains a lone surrogate`);
    }
  }
  return violations;
}
