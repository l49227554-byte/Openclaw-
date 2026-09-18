// Telegram helper module: where an outbound HTML message may be cut.
//
// The split-index search is the only part of chunking that has to reconcile three
// independent boundary rules (HTML entities, extended grapheme clusters, UTF-16 surrogate
// pairs), so it lives apart from the renderer in format.ts.
import {
  avoidTrailingGraphemeBreak,
  avoidTrailingHighSurrogateBreak,
} from "openclaw/plugin-sdk/text-chunking";
import { findTelegramHtmlEntityEnd } from "./format-html.js";

// Never return a split index that lands between a UTF-16 surrogate pair, or
// both chunks would carry a lone surrogate that re-encodes to U+FFFD. If the
// pair starts the segment, keep it whole so chunking still advances.
function clampToSurrogateBoundary(text: string, index: number): number {
  // Shared owner: an extended grapheme cluster (ZWJ emoji, flag, skin tone, combining
  // mark) must survive a message boundary, not just a surrogate pair.
  return avoidTrailingGraphemeBreak(text, 0, index);
}

// Prefer a word/paragraph boundary inside the entity-safe window so long text
// runs break between words instead of mid-word. Whitespace never falls inside
// an HTML entity, so this keeps entities intact; the caller falls back to the
// entity-safe hard cut only when the window has no interior whitespace.
function findTelegramHtmlWordSafeSplitIndex(text: string, end: number): number {
  let lastNewline = 0;
  let lastWhitespace = 0;
  for (let index = 1; index < end; index += 1) {
    const char = text[index];
    if (char === "\n") {
      lastNewline = index + 1;
    } else if (char !== undefined && /\s/.test(char)) {
      lastWhitespace = index + 1;
    }
  }
  return lastNewline > 0 ? lastNewline : lastWhitespace;
}

function findTelegramHtmlEntitySafeSplitIndex(text: string, normalizedMaxLength: number): number {
  const lastAmpersand = text.lastIndexOf("&", normalizedMaxLength - 1);
  if (lastAmpersand === -1) {
    return normalizedMaxLength;
  }
  const lastSemicolon = text.lastIndexOf(";", normalizedMaxLength - 1);
  if (lastAmpersand < lastSemicolon) {
    return normalizedMaxLength;
  }
  const entityEnd = findTelegramHtmlEntityEnd(text, lastAmpersand);
  if (entityEnd === -1 || entityEnd < normalizedMaxLength) {
    return normalizedMaxLength;
  }
  return lastAmpersand;
}

/**
 * Whether `limit` can be used as a chunk budget.
 *
 * `Infinity` qualifies: it is the caller's way of asking for no limit, and every budget
 * comparison against it resolves before any search loop runs. `NaN`, `undefined` and
 * `-Infinity` do not: `NaN` compares false against everything, which makes a budget search
 * spin instead of converging, and a negative budget cannot express an intent at all.
 */
export function isUsableTelegramChunkLimit(limit: number): boolean {
  return Number.isFinite(limit) || limit === Number.POSITIVE_INFINITY;
}

/**
 * Largest index at which `text` may be cut for a chunk of at most `maxLength` code units.
 *
 * The result is positive whenever any positive entity-safe cut exists, so callers that loop
 * on it keep making progress; it is zero only when the text opens with an entity wider than
 * the whole budget.
 *
 * `Infinity` means no limit and returns `text.length`, so no cut is made.
 *
 * @throws TypeError when `maxLength` is `NaN`, `undefined` or `-Infinity`. Every comparison
 * against `NaN` is false, so such a budget would make the boundary search below spin instead
 * of converging, and a negative budget names no reachable index.
 */
export function findTelegramHtmlSafeSplitIndex(text: string, maxLength: number): number {
  if (!isUsableTelegramChunkLimit(maxLength)) {
    throw new TypeError(
      `Telegram HTML split index requires a finite or infinite maxLength (received ${maxLength})`,
    );
  }
  if (text.length <= maxLength) {
    return text.length;
  }
  const normalizedMaxLength = Math.max(1, Math.floor(maxLength));
  const entitySafeIndex = findTelegramHtmlEntitySafeSplitIndex(text, normalizedMaxLength);
  const wordSafeIndex = findTelegramHtmlWordSafeSplitIndex(text, entitySafeIndex);
  let splitIndex = wordSafeIndex > 0 ? wordSafeIndex : entitySafeIndex;
  for (;;) {
    const clamped = clampToSurrogateBoundary(text, splitIndex);
    if (clamped >= splitIndex) {
      if (clamped > 0) {
        return clamped;
      }
      // Hard transport limits win, the same policy utf16-slice.ts documents. The grapheme
      // clamp and the entity re-check converged on a zero-width cut, which stalls chunking
      // and makes the caller fail an otherwise deliverable message. Keeping an oversized
      // cluster whole is not worth losing all progress, so fall back to the widest
      // entity-safe cut that is still surrogate-safe and strictly positive.
      return avoidTrailingHighSurrogateBreak(text, 0, entitySafeIndex);
    }
    // The grapheme clamp can retreat over an Extend character that directly follows an
    // entity's `;` (they form one cluster), which would leave a bare `&amp` behind. Re-run
    // the entity check from the moved index. Reaching here means `clamped < splitIndex`, and
    // the non-finite guard above keeps that comparison meaningful, so the index strictly
    // decreases each pass and the loop converges.
    splitIndex = findTelegramHtmlEntitySafeSplitIndex(text, clamped);
  }
}
