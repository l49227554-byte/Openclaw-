// Surrogate-safe UTF-16 string slicing helpers.
//
// Kept dependency-free (no node: imports) so browser/UI bundles can import them
// without dragging in filesystem/runtime code. See utils.ts, which re-exports
// these for the broad runtime surface.

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** Moves a chunk boundary away from the middle of a UTF-16 surrogate pair. */
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

/** Shared grapheme segmenter: constructing one per call dominates chunking loops. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Moves a chunk boundary back to an extended-grapheme-cluster boundary.
 *
 * Hard transport limits win: the returned index never exceeds `end`, so a cluster wider
 * than the whole budget is split rather than allowed to overflow the cap. That split is
 * still surrogate-safe, because a lone surrogate half is invalid UTF-16 that renders as a
 * replacement character, which is strictly worse than a partial cluster.
 */
export function avoidTrailingGraphemeBreak(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length) {
    return end;
  }

  // `containing` is undefined only past the end of the text, which the guard above excludes.
  const cluster = GRAPHEME_SEGMENTER.segment(text).containing(end);
  if (cluster === undefined || cluster.index === end) {
    return end;
  }
  // Inside a cluster: retreat to its start when that still advances past `start`,
  // otherwise the cluster alone exceeds the budget and the cut stays at the cap.
  return cluster.index > start ? cluster.index : avoidTrailingHighSurrogateBreak(text, start, end);
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
