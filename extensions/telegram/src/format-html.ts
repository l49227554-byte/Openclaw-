import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { avoidTrailingHighSurrogateBreak } from "openclaw/plugin-sdk/text-chunking";
import {
  avoidTrailingGraphemeBreak,
  firstGraphemeClusterLength,
} from "openclaw/plugin-sdk/text-utility-runtime";

export function escapeTelegramHtml(text: string): string {
  if (!/[&<>]/.test(text)) {
    return text;
  }
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeTelegramHtmlAttr(text: string): string {
  return escapeTelegramHtml(text).replace(/"/g, "&quot;");
}

const TELEGRAM_HTML_ENTITY_PATTERN = /&(#[xX][0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g;

// Structural tags that force a line boundary when projecting HTML to plain text
// (assistant transcript protection). Block-counting helpers for rich HTML are gone.
const TELEGRAM_LINE_BREAK_STRUCTURAL_TAGS = new Set([
  "aside",
  "audio",
  "blockquote",
  "caption",
  "col",
  "colgroup",
  "details",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tg-collage",
  "tg-map",
  "tg-math-block",
  "tg-slideshow",
  "tr",
  "ul",
  "video",
]);

export function isTelegramRichLineBreakStructuralTag(rawTag: string, tagName: string): boolean {
  return (
    TELEGRAM_LINE_BREAK_STRUCTURAL_TAGS.has(tagName) ||
    (tagName === "a" && /\sname="[^"]+"/i.test(rawTag))
  );
}

function isValidTelegramHtmlEntityCodePoint(codePoint: number): boolean {
  return (
    Number.isInteger(codePoint) &&
    codePoint >= 0 &&
    codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff)
  );
}

function decodeTelegramHtmlEntity(entity: string, fallback: string): string {
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    const codePoint = Number.parseInt(entity.slice(2), 16);
    return isValidTelegramHtmlEntityCodePoint(codePoint)
      ? String.fromCodePoint(codePoint)
      : fallback;
  }
  if (entity.startsWith("#")) {
    const codePoint = Number.parseInt(entity.slice(1), 10);
    return isValidTelegramHtmlEntityCodePoint(codePoint)
      ? String.fromCodePoint(codePoint)
      : fallback;
  }
  switch (entity) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
    default:
      return fallback;
  }
}

export function decodeTelegramHtmlEntities(text: string): string {
  return text.replace(TELEGRAM_HTML_ENTITY_PATTERN, (match, entity: string) =>
    decodeTelegramHtmlEntity(entity, match),
  );
}

export function findTelegramHtmlEntityEnd(text: string, start: number): number {
  if (text[start] !== "&") {
    return -1;
  }
  let index = start + 1;
  if (index >= text.length) {
    return -1;
  }
  if (text[index] === "#") {
    index += 1;
    if (index >= text.length) {
      return -1;
    }
    const isHex = text[index] === "x" || text[index] === "X";
    if (isHex) {
      index += 1;
      const hexStart = index;
      while (/[0-9A-Fa-f]/.test(text[index] ?? "")) {
        index += 1;
      }
      if (index === hexStart) {
        return -1;
      }
    } else {
      const digitStart = index;
      while (/[0-9]/.test(text[index] ?? "")) {
        index += 1;
      }
      if (index === digitStart) {
        return -1;
      }
    }
  } else {
    const nameStart = index;
    while (/[A-Za-z0-9]/.test(text[index] ?? "")) {
      index += 1;
    }
    if (index === nameStart) {
      return -1;
    }
  }
  return text[index] === ";" ? index : -1;
}

type TelegramHtmlTextEntity = {
  sourceStart: number;
  sourceEnd: number;
  decodedStart: number;
  decodedEnd: number;
  graphemeSourceStart: number;
};

function mapTelegramHtmlTextOffset(
  entities: readonly TelegramHtmlTextEntity[],
  offset: number,
  toSource: boolean,
  edge: "before" | "after" | "grapheme" = "before",
): number {
  let low = 0;
  let high = entities.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = expectDefined(
      entities[middle],
      "Telegram HTML entity binary-search midpoint",
    );
    const start = toSource ? candidate.decodedStart : candidate.sourceStart;
    if (start <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const entity = entities[low - 1];
  if (!entity) {
    return offset;
  }
  const fromStart = toSource ? entity.decodedStart : entity.sourceStart;
  const fromEnd = toSource ? entity.decodedEnd : entity.sourceEnd;
  const toStart = toSource ? entity.sourceStart : entity.decodedStart;
  const toEnd = toSource ? entity.sourceEnd : entity.decodedEnd;
  if (offset >= fromEnd) {
    return toEnd + offset - fromEnd;
  }
  if (offset === fromStart) {
    return toStart;
  }
  return edge === "after" ? toEnd : edge === "grapheme" ? entity.graphemeSourceStart : toStart;
}

function findTelegramHtmlWordSafeSplitIndex(text: string, start: number, end: number): number {
  let lastNewline = start;
  let lastWhitespace = start;
  for (let index = start + 1; index < end; index += 1) {
    const char = text[index];
    if (char === "\n") {
      lastNewline = index + 1;
    } else if (char !== undefined && /\s/.test(char)) {
      lastWhitespace = index + 1;
    }
  }
  return lastNewline > start ? lastNewline : lastWhitespace;
}

export type TelegramHtmlTextSplitter = (
  start: number,
  maxLength: number,
  allowPartialGrapheme: boolean,
) => number;

/** Prepares one text segment; returned cuts are offsets in its original HTML spelling. */
export function prepareTelegramHtmlTextSplitter(source: string): TelegramHtmlTextSplitter {
  const entities: TelegramHtmlTextEntity[] = [];
  const parts: string[] = [];
  let sourceOffset = 0;
  let decodedLength = 0;
  for (let ampersand = source.indexOf("&"); ampersand !== -1;) {
    const entityEnd = findTelegramHtmlEntityEnd(source, ampersand);
    if (entityEnd === -1) {
      ampersand = source.indexOf("&", ampersand + 1);
      continue;
    }
    const prefix = source.slice(sourceOffset, ampersand);
    const rawEntity = source.slice(ampersand, entityEnd + 1);
    const decodedEntity = decodeTelegramHtmlEntity(
      source.slice(ampersand + 1, entityEnd),
      rawEntity,
    );
    parts.push(prefix, decodedEntity);
    decodedLength += prefix.length;
    entities.push({
      sourceStart: ampersand,
      sourceEnd: entityEnd + 1,
      decodedStart: decodedLength,
      decodedEnd: decodedLength + decodedEntity.length,
      graphemeSourceStart: ampersand,
    });
    decodedLength += decodedEntity.length;
    sourceOffset = entityEnd + 1;
    ampersand = source.indexOf("&", sourceOffset);
  }
  parts.push(source.slice(sourceOffset));
  const decoded = entities.length > 0 ? parts.join("") : source;
  const firstClusterEnd = firstGraphemeClusterLength(decoded);
  for (const entity of entities) {
    if (entity.decodedEnd - entity.decodedStart !== entity.sourceEnd - entity.sourceStart) {
      continue;
    }
    // Unknown/invalid entities stay literal but indivisible. A grapheme cut inside
    // their spelling must retreat before the whole entity and any attached prefix.
    const decodedStart =
      entity.decodedStart < firstClusterEnd
        ? 0
        : avoidTrailingGraphemeBreak(decoded, 0, entity.decodedStart);
    entity.graphemeSourceStart = mapTelegramHtmlTextOffset(
      entities,
      decodedStart,
      true,
      "grapheme",
    );
  }

  return (start: number, maxLength: number, allowPartialGrapheme: boolean): number => {
    const decodedStart = mapTelegramHtmlTextOffset(entities, start, false);
    const decodedEnd = mapTelegramHtmlTextOffset(entities, start + maxLength, false);
    const sourceEnd = mapTelegramHtmlTextOffset(entities, decodedEnd, true);
    if (sourceEnd <= start) {
      return start;
    }
    const leadingClusterLength =
      decodedStart === 0
        ? firstClusterEnd
        : firstGraphemeClusterLength(decoded.slice(decodedStart));
    const leadingClusterEnd = mapTelegramHtmlTextOffset(
      entities,
      decodedStart + leadingClusterLength,
      true,
      "after",
    );
    if (!allowPartialGrapheme && leadingClusterEnd > sourceEnd) {
      return start;
    }
    let proposal = findTelegramHtmlWordSafeSplitIndex(source, start, sourceEnd);
    if (proposal === start) {
      proposal = sourceEnd;
    } else if (leadingClusterEnd <= sourceEnd) {
      proposal = Math.max(proposal, leadingClusterEnd);
    }
    const splitAt = mapTelegramHtmlTextOffset(
      entities,
      avoidTrailingGraphemeBreak(
        decoded,
        decodedStart,
        mapTelegramHtmlTextOffset(entities, proposal, false),
      ),
      true,
      "grapheme",
    );
    // Only an oversized leading cluster may require a hard cut; entities stay
    // atomic, and the shared UTF-16 helper owns the leading-surrogate exception.
    return splitAt > start ? splitAt : avoidTrailingHighSurrogateBreak(source, start, sourceEnd);
  };
}
