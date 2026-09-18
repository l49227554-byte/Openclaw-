// Text chunking tests cover splitting text into bounded model-safe chunks.
import { describe, expect, it } from "vitest";
import {
  buildGraphemeCutWitness,
  findGraphemeChunkViolations,
  findOversizedGraphemeViolations,
  GRAPHEME_WITNESSES,
  OVERSIZED_GRAPHEME_LIMIT,
  OVERSIZED_GRAPHEME_TEXT,
} from "../../packages/markdown-core/src/chunk-text.test-support.js";
import { chunkTextByBreakResolver, splitLongTextLine } from "./text-chunking.js";

describe("shared/text-chunking", () => {
  it("returns empty for blank input and the full text when under limit", () => {
    expect(chunkTextByBreakResolver("", 10, () => 5)).toStrictEqual([]);
    expect(chunkTextByBreakResolver("hello", 10, () => 2)).toEqual(["hello"]);
    expect(chunkTextByBreakResolver("hello", 0, () => 2)).toEqual(["hello"]);
    expect(chunkTextByBreakResolver("hello ", 10, () => 2)).toEqual(["hello "]);
    expect(chunkTextByBreakResolver("hello ", 0, () => 2)).toEqual(["hello "]);
  });

  it("splits at resolver-provided breakpoints and trims separator boundaries", () => {
    expect(
      chunkTextByBreakResolver("alpha beta gamma", 10, (window) => window.lastIndexOf(" ")),
    ).toEqual(["alpha", "beta gamma"]);
    expect(chunkTextByBreakResolver("abcd efgh", 4, () => 4)).toEqual(["abcd", "efgh"]);
  });

  it("falls back to hard limits for invalid break indexes", () => {
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => Number.NaN)).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => 99)).toEqual(["abcd", "efgh", "ij"]);
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => 0)).toEqual(["abcd", "efgh", "ij"]);
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => 0.5)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("normalizes positive fractional limits before splitting", () => {
    expect(chunkTextByBreakResolver("abc", 0.5, (window) => window.lastIndexOf(" "))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(splitLongTextLine("abc", 0.5, { preserveWhitespace: true })).toEqual(["a", "b", "c"]);
    expect(chunkTextByBreakResolver("😀😀", 0.5, () => -1)).toEqual(["😀", "😀"]);
    expect(splitLongTextLine("😀😀", 0.5, { preserveWhitespace: true })).toEqual(["😀", "😀"]);
    expect(splitLongTextLine("😀😀", 0.5, { preserveWhitespace: false })).toEqual(["😀", "😀"]);
  });

  it("skips empty chunks created by whitespace-only segments", () => {
    expect(
      chunkTextByBreakResolver("word     next", 5, (window) => window.lastIndexOf(" ")),
    ).toEqual(["word", "next"]);
  });

  it("trims trailing whitespace from emitted chunks before continuing", () => {
    expect(chunkTextByBreakResolver("abc   def", 6, (window) => window.lastIndexOf(" "))).toEqual([
      "abc",
      "def",
    ]);
  });

  it.each([
    { text: "  ! ", limit: 2, expected: ["!"] },
    { text: "a b ", limit: 2, expected: ["a", "b"] },
    { text: "alpha beta   ", limit: 8, expected: ["alpha", "beta"] },
  ])("trims trailing whitespace from the final chunk: $text", ({ text, limit, expected }) => {
    expect(chunkTextByBreakResolver(text, limit, (window) => window.lastIndexOf(" "))).toEqual(
      expected,
    );
  });
});

describe("grapheme-safe hard cuts", () => {
  const LIMIT = 12;
  const lastSpace = (window: string) => window.lastIndexOf(" ");

  it.each(GRAPHEME_WITNESSES)(
    "splitLongTextLine keeps a $name whole with preserved whitespace",
    (witness) => {
      const text = buildGraphemeCutWitness(witness, LIMIT);
      const chunks = splitLongTextLine(text, LIMIT, { preserveWhitespace: true });

      expect(findGraphemeChunkViolations(text, chunks, LIMIT)).toEqual([]);
      expect(chunks).toEqual(["a".repeat(LIMIT - witness.cut), `${witness.cluster}Z`]);
    },
  );

  it.each(GRAPHEME_WITNESSES)(
    "splitLongTextLine keeps a $name whole when no whitespace break exists",
    (witness) => {
      const text = buildGraphemeCutWitness(witness, LIMIT);
      const chunks = splitLongTextLine(text, LIMIT, { preserveWhitespace: false });

      expect(findGraphemeChunkViolations(text, chunks, LIMIT)).toEqual([]);
      expect(chunks).toEqual(["a".repeat(LIMIT - witness.cut), `${witness.cluster}Z`]);
    },
  );

  it.each(GRAPHEME_WITNESSES)(
    "chunkTextByBreakResolver keeps a $name whole at the hard-limit fallback",
    (witness) => {
      const text = buildGraphemeCutWitness(witness, LIMIT);
      const chunks = chunkTextByBreakResolver(text, LIMIT, lastSpace);

      expect(findGraphemeChunkViolations(text, chunks, LIMIT)).toEqual([]);
      expect(chunks).toEqual(["a".repeat(LIMIT - witness.cut), `${witness.cluster}Z`]);
    },
  );

  it("still advances through a single grapheme wider than the whole limit", () => {
    const limit = OVERSIZED_GRAPHEME_LIMIT;
    const preserved = splitLongTextLine(OVERSIZED_GRAPHEME_TEXT, limit, {
      preserveWhitespace: true,
    });
    const collapsed = splitLongTextLine(OVERSIZED_GRAPHEME_TEXT, limit, {
      preserveWhitespace: false,
    });
    const resolved = chunkTextByBreakResolver(OVERSIZED_GRAPHEME_TEXT, limit, lastSpace);

    expect(findOversizedGraphemeViolations(preserved, limit)).toEqual([]);
    expect(findOversizedGraphemeViolations(collapsed, limit)).toEqual([]);
    expect(findOversizedGraphemeViolations(resolved, limit)).toEqual([]);
  });
});
