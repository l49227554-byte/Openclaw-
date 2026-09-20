import katex from "katex";
import type { MarkdownIt, StateBlock, StateInline } from "markdown-it";

const DISPLAY_DELIMITERS = [
  { open: "$$", close: "$$", displayMode: true },
  { open: "\\[", close: "\\]", displayMode: true },
] as const;
const INLINE_DELIMITERS = [
  { open: "$$", close: "$$", displayMode: true },
  { open: "\\[", close: "\\]", displayMode: true },
  { open: "\\(", close: "\\)", displayMode: false },
  { open: "$", close: "$", displayMode: false },
] as const;

const MAX_MATH_SCAN = 4096;
const MAX_MATH_EXPRESSIONS = 200;
let renderedMathExpressions = 0;
const BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<]*/giu;

export function resetMarkdownMathBudget() {
  renderedMathExpressions = 0;
}

function renderMath(source: string, displayMode: boolean): string {
  if (renderedMathExpressions >= MAX_MATH_EXPRESSIONS) {
    return "";
  }
  renderedMathExpressions += 1;
  try {
    return (
      katex
        .renderToString(source, {
          displayMode,
          output: "htmlAndMathml",
          strict: "ignore",
          throwOnError: false,
          trust: false,
          maxExpand: 1000,
          maxSize: 10,
        })
        // KaTeX's source annotation is redundant for our accessible MathML
        // branch and would echo untrusted command arguments into the DOM.
        .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/gu, "")
    );
  } catch {
    // Keep malformed or unexpectedly expensive input visible as literal text.
    return "";
  }
}

function escapeMathFallback(source: string): string {
  return source.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function findUnescapedMathDelimiter(source: string, needle: string, start: number): number {
  const end = Math.min(source.length, start + MAX_MATH_SCAN);
  for (let index = start; index < end; index += 1) {
    if (source[index] !== needle[0] || !source.startsWith(needle, index)) {
      continue;
    }
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      return index;
    }
  }
  return -1;
}

// Inline states own one source string; reuse its URL ranges across delimiter probes.
const bareUrlRanges = new WeakMap<StateInline, Array<readonly [number, number]>>();

function isInsideBareUrl(state: StateInline): boolean {
  let ranges = bareUrlRanges.get(state);
  if (!ranges) {
    ranges = [];
    BARE_URL_RE.lastIndex = 0;
    for (const match of state.src.matchAll(BARE_URL_RE)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
    bareUrlRanges.set(state, ranges);
  }
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const [start, end] = ranges[middle]!;
    if (state.pos < start) {
      high = middle;
    } else if (state.pos >= end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function parseDisplayMath(state: StateBlock, startLine: number, endLine: number, silent: boolean) {
  const lineStart = state.bMarks[startLine]! + state.tShift[startLine]!;
  const lineEnd = state.eMarks[startLine]!;
  const line = state.src.slice(lineStart, lineEnd);
  const delimiter = DISPLAY_DELIMITERS.find(({ open }) => line.startsWith(open));
  if (!delimiter) {
    return false;
  }
  const afterOpen = line.slice(delimiter.open.length);
  const sameLineClose = findUnescapedMathDelimiter(afterOpen, delimiter.close, 0);
  let nextLine = startLine;
  let latex: string;
  if (sameLineClose >= 0) {
    if (afterOpen.slice(sameLineClose + delimiter.close.length).trim()) {
      return false;
    }
    latex = afterOpen.slice(0, sameLineClose).trim();
  } else {
    const lines: string[] = [afterOpen];
    let closeLine = -1;
    for (let lineIndex = startLine + 1; lineIndex < endLine; lineIndex += 1) {
      const currentStart = state.bMarks[lineIndex]! + state.tShift[lineIndex]!;
      const current = state.src.slice(currentStart, state.eMarks[lineIndex]!);
      const close = findUnescapedMathDelimiter(current, delimiter.close, 0);
      if (close >= 0) {
        if (current.slice(close + delimiter.close.length).trim()) {
          return false;
        }
        lines.push(current.slice(0, close));
        closeLine = lineIndex;
        break;
      }
      lines.push(current);
    }
    if (closeLine < 0) {
      return false;
    }
    latex = lines.join("\n").trim();
    nextLine = closeLine;
  }
  if (!latex || silent) {
    return Boolean(latex);
  }
  const token = state.push("math_block", "div", 0);
  token.block = true;
  token.content = latex;
  token.map = [startLine, nextLine + 1];
  token.meta = { displayMode: delimiter.displayMode };
  state.line = nextLine + 1;
  return true;
}

function parseInlineMath(state: StateInline, silent: boolean): boolean {
  const source = state.src.slice(state.pos);
  const delimiter = INLINE_DELIMITERS.find(({ open }) => source.startsWith(open));
  if (!delimiter) {
    return false;
  }
  if (isInsideBareUrl(state)) {
    return false;
  }
  const contentStart = delimiter.open.length;
  const close = findUnescapedMathDelimiter(source, delimiter.close, contentStart);
  if (close <= contentStart) {
    return false;
  }
  if (
    delimiter.open === "$" &&
    (/\s/u.test(source.charAt(contentStart)) ||
      /\s/u.test(source.charAt(close - 1)) ||
      /^(?:-\$?\d|\d)/u.test(source.slice(close + delimiter.close.length)) ||
      /\d-$/u.test(state.src.slice(0, state.pos)))
  ) {
    return false;
  }
  state.pos += close + delimiter.close.length;
  if (silent) {
    return true;
  }
  const token = state.push("math_inline", "span", 0);
  token.content = source.slice(contentStart, close);
  token.meta = { displayMode: delimiter.displayMode };
  return true;
}

export function installMarkdownMath(markdownParser: MarkdownIt) {
  markdownParser.block.ruler.before("paragraph", "math_block", parseDisplayMath, {
    alt: ["paragraph"],
  });
  markdownParser.inline.ruler.before("escape", "math_inline", parseInlineMath);
  markdownParser.renderer.rules.math_inline = (tokens, index) => {
    const token = tokens[index];
    return token
      ? renderMath(token.content, Boolean(token.meta?.displayMode)) ||
          (token.meta?.displayMode
            ? `$$${escapeMathFallback(token.content)}$$`
            : `$${escapeMathFallback(token.content)}$`)
      : "";
  };
  markdownParser.renderer.rules.math_block = (tokens, index) => {
    const token = tokens[index];
    if (!token) {
      return "";
    }
    return renderMath(token.content, true) || `$$${escapeMathFallback(token.content)}$$`;
  };
}
