// Markdown Core tests cover plain-text chunking behavior.
import { describe, expect, it } from "vitest";
import { chunkText, chunkTextRanges } from "./chunk-text.js";
import {
  buildGraphemeCutWitness,
  findGraphemeChunkViolations,
  findOversizedGraphemeViolations,
  GRAPHEME_WITNESSES,
  OVERSIZED_GRAPHEME_LIMIT,
  OVERSIZED_GRAPHEME_TEXT,
} from "./chunk-text.test-support.js";

describe("chunkText", () => {
  it("normalizes positive fractional limits without emitting empty chunks", () => {
    expect(chunkText("abc", 0.5)).toEqual(["a", "b", "c"]);
    expect(chunkText("😀😀", 0.5)).toEqual(["😀", "😀"]);
  });
});

describe("grapheme-safe hard cuts", () => {
  const LIMIT = 12;

  it.each(GRAPHEME_WITNESSES)("chunkText keeps a $name whole at the hard cut", (witness) => {
    const text = buildGraphemeCutWitness(witness, LIMIT);
    const chunks = chunkText(text, LIMIT);

    expect(findGraphemeChunkViolations(text, chunks, LIMIT)).toEqual([]);
    expect(chunks).toEqual(["a".repeat(LIMIT - witness.cut), `${witness.cluster}Z`]);
  });

  it.each(GRAPHEME_WITNESSES)("chunkTextRanges keeps a $name whole in hard mode", (witness) => {
    const text = buildGraphemeCutWitness(witness, LIMIT);
    const ranges = chunkTextRanges(text, { limit: LIMIT, mode: "hard" });
    const chunks = ranges.map(({ start, end }) => text.slice(start, end));

    expect(findGraphemeChunkViolations(text, chunks, LIMIT)).toEqual([]);
    expect(chunks.join("")).toBe(text);
    expect(chunks).toEqual(["a".repeat(LIMIT - witness.cut), `${witness.cluster}Z`]);
  });

  it.each(GRAPHEME_WITNESSES)(
    "chunkTextRanges keeps a $name whole when preferred mode falls back to a hard cut",
    (witness) => {
      // No whitespace inside the first window, so preferred mode takes the hard-cut fallback.
      const text = `${buildGraphemeCutWitness(witness, LIMIT)} tail`;
      const ranges = chunkTextRanges(text, { limit: LIMIT, mode: "preferred" });
      const chunks = ranges.map(({ start, end }) => text.slice(start, end));

      expect(findGraphemeChunkViolations(text, chunks, LIMIT)).toEqual([]);
      expect(chunks.join("")).toBe(text);
      expect(chunks[0]).toBe("a".repeat(LIMIT - witness.cut));
    },
  );

  it("still advances through a single grapheme wider than the whole limit", () => {
    const limit = OVERSIZED_GRAPHEME_LIMIT;
    const chunks = chunkText(OVERSIZED_GRAPHEME_TEXT, limit);
    const ranges = chunkTextRanges(OVERSIZED_GRAPHEME_TEXT, { limit, mode: "hard" });
    const rangeChunks = ranges.map(({ start, end }) => OVERSIZED_GRAPHEME_TEXT.slice(start, end));

    expect(findOversizedGraphemeViolations(chunks, limit)).toEqual([]);
    expect(findOversizedGraphemeViolations(rangeChunks, limit)).toEqual([]);
    expect(chunks.length).toBeGreaterThanOrEqual(Math.ceil(OVERSIZED_GRAPHEME_TEXT.length / limit));
  });
});
