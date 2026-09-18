// Tests for surrogate-safe UTF-16 string slicing helpers.
import { describe, expect, it } from "vitest";
import {
  avoidTrailingGraphemeBreak,
  avoidTrailingHighSurrogateBreak,
  firstGraphemeClusterLength,
  sliceUtf16Safe,
  truncateUtf16Safe,
  truncateWithMarker,
} from "./utf16-slice.js";

describe("avoidTrailingHighSurrogateBreak", () => {
  it("keeps ordinary and terminal boundaries unchanged", () => {
    expect(avoidTrailingHighSurrogateBreak("hello", 0, 3)).toBe(3);
    expect(avoidTrailingHighSurrogateBreak("hello", 0, 5)).toBe(5);
  });

  it("moves a split before a surrogate pair when room remains", () => {
    expect(avoidTrailingHighSurrogateBreak("a🤖b", 0, 2)).toBe(1);
  });

  it("includes the full pair when a one-unit chunk starts with it", () => {
    expect(avoidTrailingHighSurrogateBreak("🤖b", 0, 1)).toBe(2);
  });

  it("overshoots the limit by exactly one code unit when the pair starts at start", () => {
    // Pins the documented exception to the "never exceeds end" rule. Retreating here would
    // return `start` and stall the caller, so the helper trades one code unit for progress.
    expect(avoidTrailingHighSurrogateBreak("\u{1F600}X", 0, 1)).toBe(2);
    expect(avoidTrailingHighSurrogateBreak("A\u{1F600}X", 1, 2)).toBe(3);
  });
});

describe("sliceUtf16Safe", () => {
  it.each<[string, Parameters<typeof sliceUtf16Safe>, string]>([
    ["slices ASCII string normally", ["hello world", 0, 5], "hello"],
    ["handles negative start", ["hello world", -5], "world"],
    ["handles negative end", ["hello world", 0, -6], "hello"],
    ["handles start beyond length", ["hello", 10], ""],
    ["handles end beyond length", ["hello", 0, 10], "hello"],
    ["returns empty when start > end, matching String.prototype.slice", ["hello", 3, 1], ""],
    ["preserves emoji with surrogate pairs", ["👨‍👩‍👧‍👦", 0], "👨‍👩‍👧‍👦"],
    ["returns empty string when slicing middle of surrogate pair", ["👨👩", 1, 3], ""],
    ["returns empty string when slicing at start of surrogate pair", ["👨👩", 0, 1], ""],
    ["handles empty string", ["", 0], ""],
    ["handles undefined end", ["hello", 2], "llo"],
  ])("%s", (_name, args, expected) => {
    expect(sliceUtf16Safe(...args)).toBe(expected);
  });
});

describe("truncateUtf16Safe", () => {
  it.each<[string, Parameters<typeof truncateUtf16Safe>, string]>([
    ["returns input when shorter than limit", ["hello", 10], "hello"],
    ["truncates when longer than limit", ["hello world", 5], "hello"],
    ["handles zero limit", ["hello", 0], ""],
    ["handles negative limit", ["hello", -1], ""],
    ["floors decimal limit", ["hello world", 5.7], "hello"],
    ["returns empty string when truncating at surrogate pair boundary", ["👨👩", 1], ""],
  ])("%s", (_name, args, expected) => {
    expect(truncateUtf16Safe(...args)).toBe(expected);
  });
});

describe("truncateWithMarker", () => {
  it.each([
    {
      name: "returns values at the boundary unchanged",
      value: "hello",
      max: 5,
      options: { marker: "...", reserve: 3, trimEnd: false },
      expected: "hello",
    },
    {
      name: "reserves marker width",
      value: "hello world",
      max: 8,
      options: { marker: "...", reserve: 3, trimEnd: false },
      expected: "hello...",
    },
    {
      name: "supports markers outside the limit",
      value: "hello world",
      max: 5,
      options: { marker: "...", reserve: 0, trimEnd: false },
      expected: "hello...",
    },
    {
      name: "trims only the truncated prefix",
      value: "hello   world",
      max: 9,
      options: { marker: "...", reserve: 3, trimEnd: true },
      expected: "hello...",
    },
    {
      name: "keeps surrogate pairs well formed",
      value: "ab🚀tail",
      max: 4,
      options: { marker: "…", reserve: 1, trimEnd: false },
      expected: "ab…",
    },
    {
      name: "preserves marker output at zero limits",
      value: "hello",
      max: 0,
      options: { marker: "…", reserve: 1, trimEnd: false },
      expected: "…",
    },
  ] as const)("$name", ({ value, max, options, expected }) => {
    expect(truncateWithMarker(value, max, options)).toBe(expected);
  });
});

describe("avoidTrailingGraphemeBreak", () => {
  // Escape-literal on purpose: a typed "café" is a legal spelling of both the precomposed
  // (4 unit) and decomposed (5 unit) forms, and they render identically.
  const witnesses: Record<string, string> = {
    family: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
    aFamilyB: "a\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}b",
    flag: "\u{1F1FA}\u{1F1F8}",
    skin: "\u{1F44D}\u{1F3FB}",
    combining: "cafe\u0301",
    indic: "\u0915\u094D\u0937\u093F",
    robot: "a\u{1F916}b",
  };

  // contract:begin
  const CONTRACT = [
    { witness: "aFamilyB", start: 0, end: 2, expected: 1 },
    { witness: "robot", start: 0, end: 2, expected: 1 },
    { witness: "aFamilyB", start: 1, end: 5, expected: 4 },
    { witness: "aFamilyB", start: 0, end: 6, expected: 1 },
    { witness: "family", start: 0, end: 5, expected: 5 },
    { witness: "flag", start: 0, end: 2, expected: 2 },
    { witness: "skin", start: 0, end: 2, expected: 2 },
    { witness: "combining", start: 0, end: 4, expected: 3 },
    { witness: "indic", start: 0, end: 2, expected: 2 },
    { witness: "family", start: 0, end: 11, expected: 11 },
    { witness: "aFamilyB", start: 0, end: 13, expected: 13 },
    { witness: "robot", start: 2, end: 2, expected: 2 },
  ] as const;
  // contract:end

  it.each(CONTRACT)("$witness[$start:$end] -> $expected", ({ witness, start, end, expected }) => {
    const text = witnesses[witness];
    if (text === undefined) {
      throw new Error(`missing witness text for case ${witness}`);
    }
    const result = avoidTrailingGraphemeBreak(text, start, end);
    expect(result).toBe(expected);
    // Every case here retreats within the budget; the documented one-unit overshoot is
    // pinned separately below because it is the sole exception to this bound.
    expect(result).toBeLessThanOrEqual(end);
    if (end > start) {
      expect(result).toBeGreaterThan(start);
    }
  });

  it("overshoots the limit by exactly one code unit when a pair starts at start", () => {
    // The cluster starts at `start`, so the helper cannot retreat and delegates to the
    // surrogate guard, which moves forward instead of returning a zero-width cut.
    expect(avoidTrailingGraphemeBreak("\u{1F600}X", 0, 1)).toBe(2);
    expect(avoidTrailingGraphemeBreak("A\u{1F600}X", 1, 2)).toBe(3);
  });
});

describe("firstGraphemeClusterLength", () => {
  // Escape-literal for the same reason as above: these clusters are invisible in source.
  it.each([
    { name: "empty text", text: "", expected: 0 },
    { name: "ascii", text: "abc", expected: 1 },
    { name: "surrogate pair", text: "\u{1F916}b", expected: 2 },
    {
      name: "family ZWJ sequence",
      text: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}b",
      expected: 11,
    },
    { name: "regional indicator flag", text: "\u{1F1FA}\u{1F1F8}\u{1F1FA}", expected: 4 },
    { name: "skin tone modifier", text: "\u{1F44D}\u{1F3FB}!", expected: 4 },
    { name: "base plus combining mark", text: "e\u0301x", expected: 2 },
    { name: "Indic conjunct with vowel sign", text: "\u0915\u094D\u0937\u093Fx", expected: 4 },
  ] as const)("$name", ({ text, expected }) => {
    expect(firstGraphemeClusterLength(text)).toBe(expected);
  });
});
