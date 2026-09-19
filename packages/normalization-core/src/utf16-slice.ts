// Dependency-free UTF-16 slicing helpers shared by runtime and browser bundles.

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Moves a chunk boundary away from the middle of a UTF-16 surrogate pair.
 *
 * Interior cuts advance past start. If the pair begins at start, include it even
 * when that exceeds end by one code unit; otherwise retreat before the pair.
 */
export function avoidTrailingHighSurrogateBreak(text: string, start: number, end: number): number {
  if (
    end <= start ||
    end >= text.length ||
    !isHighSurrogate(text.charCodeAt(end - 1)) ||
    !isLowSurrogate(text.charCodeAt(end))
  ) {
    return end;
  }
  const adjusted = end - 1;
  return adjusted > start ? adjusted : end + 1;
}

let graphemeSegmenter: Intl.Segmenter | undefined;

// Lazy initialization keeps unused browser imports free of Segmenter side effects.
function getGraphemeSegmenter(): Intl.Segmenter {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return graphemeSegmenter;
}

/**
 * Retreats to a grapheme boundary, falling back to a surrogate-safe cut when the
 * leading cluster exceeds the budget. Interior cuts always advance; as with the
 * surrogate helper, a leading pair can exceed end by one code unit.
 */
export function avoidTrailingGraphemeBreak(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length) {
    return end;
  }

  // An interior end always belongs to a segment.
  const cluster = getGraphemeSegmenter().segment(text).containing(end);
  if (cluster === undefined || cluster.index === end) {
    return end;
  }
  return cluster.index > start ? cluster.index : avoidTrailingHighSurrogateBreak(text, start, end);
}

/** Width to reserve for the first whole grapheme, or zero for empty text. */
export function firstGraphemeClusterLength(text: string): number {
  if (!text) {
    return 0;
  }
  return getGraphemeSegmenter().segment(text).containing(0)?.segment.length ?? 0;
}

const WHITESPACE_GRAPHEME_RE = /^\s+$/u;

/** Skips only whole whitespace graphemes, never the base of a space-plus-mark cluster. */
export function skipWhitespaceGraphemes(
  text: string,
  start = 0,
  maxGraphemes = Number.POSITIVE_INFINITY,
): number {
  if (!/\s/u.test(text.charAt(start))) {
    return start;
  }
  const segments = getGraphemeSegmenter().segment(text);
  let cursor = start;
  for (let count = 0; count < maxGraphemes && cursor < text.length; count += 1) {
    const cluster = segments.containing(cursor);
    if (!cluster || cluster.index !== cursor || !WHITESPACE_GRAPHEME_RE.test(cluster.segment)) {
      break;
    }
    cursor += cluster.segment.length;
  }
  return cursor;
}

/** Trims only whole trailing whitespace graphemes from a source prefix. */
export function trimEndWhitespaceGraphemes(text: string, end = text.length): string {
  if (!/\s/u.test(text.charAt(end - 1))) {
    return text.slice(0, end);
  }
  const segments = getGraphemeSegmenter().segment(text);
  let cursor = end;
  while (cursor > 0) {
    const cluster = segments.containing(cursor - 1);
    if (
      !cluster ||
      cluster.index + cluster.segment.length > cursor ||
      !WHITESPACE_GRAPHEME_RE.test(cluster.segment)
    ) {
      break;
    }
    cursor = cluster.index;
  }
  return text.slice(0, cursor);
}

/** Slices a UTF-16 string without returning dangling surrogate halves at either edge. */
export function sliceUtf16Safe(input: string, start: number, end?: number): string {
  const len = input.length;

  let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let to = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);

  if (to <= from) {
    return "";
  }

  if (from > 0 && from < len) {
    const codeUnit = input.charCodeAt(from);
    if (isLowSurrogate(codeUnit) && isHighSurrogate(input.charCodeAt(from - 1))) {
      from += 1;
    }
  }

  if (to > 0 && to < len) {
    const codeUnit = input.charCodeAt(to - 1);
    if (isHighSurrogate(codeUnit) && isLowSurrogate(input.charCodeAt(to))) {
      to -= 1;
    }
  }

  return input.slice(from, to);
}

/** Truncates a UTF-16 string without cutting a surrogate pair in half. */
export function truncateUtf16Safe(input: string, maxLen: number): string {
  const limit = Math.max(0, Math.floor(maxLen));
  if (input.length <= limit) {
    return input;
  }
  return sliceUtf16Safe(input, 0, limit);
}

/** Truncates text and appends a marker while preserving the caller's reserved width contract. */
export function truncateWithMarker(
  value: string,
  max: number,
  options: { marker: string; reserve: number; trimEnd: boolean },
): string {
  if (value.length <= max) {
    return value;
  }
  const prefix = truncateUtf16Safe(value, max - options.reserve);
  return `${options.trimEnd ? prefix.trimEnd() : prefix}${options.marker}`;
}
