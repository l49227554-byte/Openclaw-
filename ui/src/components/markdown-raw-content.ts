const PROGRESS_CARD_RAW_CONTENT_TAGS = ["script", "style", "iframe", "object", "template"];

interface ProgressCardRawContentTag {
  end: number;
  isClosing: boolean;
  name: string;
  start: number;
}

function isAsciiWordCharacter(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  );
}

function readProgressCardRawContentTag(
  input: string,
  start: number,
  close: number,
): ProgressCardRawContentTag | null {
  let nameStart = start + 1;
  const isClosing = input[nameStart] === "/";
  if (isClosing) {
    nameStart += 1;
  }
  const name = PROGRESS_CARD_RAW_CONTENT_TAGS.find((candidate) => {
    const nameEnd = nameStart + candidate.length;
    return (
      input.slice(nameStart, nameEnd).toLowerCase() === candidate &&
      !isAsciiWordCharacter(input[nameEnd])
    );
  });
  if (!name) {
    return null;
  }
  const nameEnd = nameStart + name.length;
  if (isClosing && input.slice(nameEnd, close).trim() !== "") {
    return null;
  }
  return { start, end: close + 1, isClosing, name };
}

export function stripProgressCardRawContentBlocks(input: string): string {
  const tags: ProgressCardRawContentTag[] = [];
  let searchFrom = 0;
  let nextClose = input.indexOf(">");
  while (searchFrom < input.length) {
    const start = input.indexOf("<", searchFrom);
    if (start === -1) {
      break;
    }
    while (nextClose !== -1 && nextClose < start) {
      nextClose = input.indexOf(">", nextClose + 1);
    }
    if (nextClose === -1) {
      break;
    }
    const tag = readProgressCardRawContentTag(input, start, nextClose);
    if (tag) {
      tags.push(tag);
      searchFrom = tag.end;
    } else {
      searchFrom = start + 1;
    }
  }

  // Pair each opener with the next compatible close in one reverse pass. This
  // avoids rescanning the remaining message for every unmatched opening tag.
  const nextClosingTag = new Map<string, number>();
  const matchingClose = Array.from({ length: tags.length }, () => -1);
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    const tag = tags[index];
    if (!tag) {
      continue;
    }
    if (tag.isClosing) {
      nextClosingTag.set(tag.name, index);
    } else {
      matchingClose[index] = nextClosingTag.get(tag.name) ?? -1;
    }
  }

  let output = "";
  let cursor = 0;
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (!tag) {
      continue;
    }
    const closeIndex = matchingClose[index] ?? -1;
    if (tag.isClosing || closeIndex < 0) {
      continue;
    }
    const close = tags[closeIndex];
    if (!close) {
      continue;
    }
    output += input.slice(cursor, tag.start);
    cursor = close.end;
    while ((tags[index + 1]?.start ?? Number.POSITIVE_INFINITY) < cursor) {
      index += 1;
    }
  }
  return cursor === 0 ? input : output + input.slice(cursor);
}
