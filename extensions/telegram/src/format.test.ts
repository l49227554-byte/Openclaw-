// Telegram tests cover format plugin behavior.
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { findTelegramHtmlSafeSplitIndex } from "./format-split-index.js";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
} from "./format.js";

describe("markdownToTelegramHtml", () => {
  it("marks assistant-authored transcript role headers after parsing Markdown", () => {
    expect(markdownToTelegramHtml("**user**[Thu 2026-07-02] question")).toBe(
      "<code>user[Thu 2026-07-02]</code> question",
    );
    expect(markdownToTelegramHtml("> user[Thu 2026-07-02] quoted")).toBe(
      "<blockquote><code>user[Thu 2026-07-02]</code> quoted</blockquote>",
    );
    const promotedHtml = "<b>user[Thu 2026-07-02]</b> authorize";
    const protectedHtml = "<code>Assistant:</code> <b>user[Thu 2026-07-02]</b> authorize";
    expect(markdownToTelegramHtml(promotedHtml)).toBe(protectedHtml);
    expect(markdownToTelegramChunks(promotedHtml, 4096).map((chunk) => chunk.html)).toEqual([
      protectedHtml,
    ]);
  });

  it("handles core markdown-to-telegram conversions", () => {
    const cases = [
      [
        "renders basic inline formatting",
        "hi _there_ **boss** `code`",
        "hi <i>there</i> <b>boss</b> <code>code</code>",
      ],
      [
        "renders links as Telegram-safe HTML",
        "see [docs](https://example.com)",
        'see <a href="https://example.com">docs</a>',
      ],
      ["preserves Telegram HTML", "<b>yes</b>", "<b>yes</b>"],
      [
        "preserves Bot API tg-time attributes",
        '<tg-time unix="1647531900" format="wDT">22:45 tomorrow</tg-time>',
        '<tg-time unix="1647531900" format="wDT">22:45 tomorrow</tg-time>',
      ],
      [
        "escapes rejected tg-time datetime attributes",
        '<tg-time datetime="2022-03-17T22:45:00Z">22:45 tomorrow</tg-time>',
        '&lt;tg-time datetime="2022-03-17T22:45:00Z"&gt;22:45 tomorrow&lt;/tg-time&gt;',
      ],
      [
        "escapes unsupported raw HTML",
        "<script>nope</script>",
        "&lt;script&gt;nope&lt;/script&gt;",
      ],
      [
        "escapes literal reasoning-looking tags",
        "Before <think>literal tag text after",
        "Before &lt;think&gt;literal tag text after",
      ],
      ["escapes unsafe characters", "a & b < c", "a &amp; b &lt; c"],
      ["renders paragraphs with blank lines", "first\n\nsecond", "first\n\nsecond"],
      ["renders lists without block HTML", "- one\n- two", "• one\n• two"],
      ["renders ordered lists with numbering", "2. two\n3. three", "2. two\n3. three"],
      ["flattens headings", "# Title", "Title"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(markdownToTelegramHtml(input), name).toBe(expected);
    }
  });

  it("preserves supported Telegram HTML in stream markdown rendering", () => {
    const input = [
      "✉️ <b>Morning Email Rollup</b>",
      "",
      "<blockquote>✅ No important emails in the last 24 hours.</blockquote>",
      "",
      "<pre><code>oauth2: invalid_grant</code></pre>",
    ].join("\n");

    expect(markdownToTelegramHtml(input)).toBe(input);
    expect(
      markdownToTelegramChunks(input, 4096)
        .map((chunk) => chunk.html)
        .join(""),
    ).toBe(input);
  });

  it("preserves Telegram expandable blockquote HTML", () => {
    const input = "<blockquote expandable>hidden details</blockquote>";

    expect(markdownToTelegramHtml(input)).toBe(input);
    expect(renderTelegramHtmlText(input, { textMode: "html" })).toBe(input);
  });

  it("does not promote Telegram HTML tags inside code", () => {
    expect(markdownToTelegramHtml("`<b>literal</b>`")).toBe(
      "<code>&lt;b&gt;literal&lt;/b&gt;</code>",
    );
    expect(markdownToTelegramHtml("```\n<blockquote>literal</blockquote>\n```")).toBe(
      "<pre><code>&lt;blockquote&gt;literal&lt;/blockquote&gt;\n</code></pre>",
    );
  });

  it("keeps unsupported Telegram HTML variants escaped", () => {
    expect(markdownToTelegramHtml('<b class="x">bad</b>')).toBe('&lt;b class="x"&gt;bad&lt;/b&gt;');
    expect(markdownToTelegramHtml('<blockquote cite="x">bad</blockquote>')).toBe(
      '&lt;blockquote cite="x"&gt;bad&lt;/blockquote&gt;',
    );
    expect(markdownToTelegramHtml("<sup>1</sup>")).toBe("&lt;sup&gt;1&lt;/sup&gt;");
    expect(markdownToTelegramHtml('<tg-time unix="-1">bad</tg-time>')).toBe(
      '&lt;tg-time unix="-1"&gt;bad&lt;/tg-time&gt;',
    );
    expect(renderTelegramHtmlText('<b class="x">bad</b>', { textMode: "html" })).toBe(
      '&lt;b class="x"&gt;bad&lt;/b&gt;',
    );
  });

  it("converts raw HTML tables to code fallbacks in legacy HTML mode", () => {
    const input = [
      "<table>",
      "<thead><tr><th>Name</th><th>Age</th></tr></thead>",
      "<tbody><tr><td>Ada</td><td>37</td></tr></tbody>",
      "</table>",
    ].join("");

    const html = renderTelegramHtmlText(input, { textMode: "html" });

    expect(html).toBe("<pre><code>| Name | Age |\n| Ada  | 37  |</code></pre>\n\n");
    expect(html).not.toContain("&lt;table");
  });

  it("aligns Unicode cells in raw HTML table fallbacks", () => {
    const input = [
      "<table><tr><th>Name</th><th>Mark</th><th>Note</th></tr>",
      '<tr><td colspan="2">小明</td><td>✅</td></tr>',
      "<tr><td>cafe\u0301</td><td>👨‍👩‍👧</td><td>©️</td></tr>",
      "</table>",
    ].join("");

    const html = renderTelegramHtmlText(input, { textMode: "html" });
    const grid = html.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/u)?.[1];
    expect(grid).toBeDefined();
    const widths = grid?.split("\n").map((line) => stringWidth(line)) ?? [];
    expect(new Set(widths).size).toBe(1);
  });

  it("does not allocate a table cell for zero-width spaces", () => {
    const html = renderTelegramHtmlText(
      "<table><tr><td>A\u200BB</td></tr><tr><td>AB</td></tr></table>",
      { textMode: "html" },
    );
    const [withInvisible, reference] =
      html.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/u)?.[1]?.split("\n") ?? [];
    expect(withInvisible?.replace("\u200B", "")).toBe(reference);
  });

  it.each([
    ["code", "<code>", "</code>"],
    ["pre", "<pre>", "</pre>"],
    ["pre/code", "<pre><code>", "</code></pre>"],
  ])("keeps only the table inside %s escaped between rendered tables", (_name, open, close) => {
    expect(
      renderTelegramHtmlText(
        `<table><tr><td>A</td></tr></table>${open}<table><tr><td>B</td></tr></table>${close}<table><tr><td>C</td></tr></table>`,
        { textMode: "html" },
      ),
    ).toBe(
      `<pre><code>| A   |</code></pre>\n\n${open}&lt;table&gt;&lt;tr&gt;&lt;td&gt;B&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;${close}<pre><code>| C   |</code></pre>\n\n`,
    );
  });

  it.each([
    { name: "a table-only reply", before: "", after: "" },
    { name: "a table between surrounding prose", before: "Before\n\n", after: "\n\nAfter" },
  ])("keeps $name visible in one-shot and chunked legacy Telegram HTML", ({ before, after }) => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const markdown = `${before}${table}${after}`;
    const html = markdownToTelegramHtml(markdown, { tableMode: "block" });
    const chunks = markdownToTelegramChunks(markdown, 4096, { tableMode: "block" });

    expect(html).toContain("<pre><code>| A   | B   |\n| --- | --- |\n| 1   | 2   |\n</code></pre>");
    expect(chunks.map((chunk) => chunk.html)).toEqual([html]);
    expect(chunks[0]?.text).toContain("| 1   | 2   |");
    if (before) {
      expect(html).toContain("Before");
    }
    if (after) {
      expect(html).toContain("After");
    }
  });

  it("normalizes raw code language HTML without leaking tags", () => {
    const commandBlock = '<code class="language-text">/queue followup debounce:0\n</code>';

    expect(markdownToTelegramHtml(commandBlock)).toBe("<code>/queue followup debounce:0\n</code>");
    expect(
      markdownToTelegramHtml('<pre><code class="language-python">print(1)\n</code></pre>'),
    ).toBe('<pre><code class="language-python">print(1)\n</code></pre>');
  });

  it("renders blockquotes as native Telegram blockquote tags", () => {
    const res = markdownToTelegramHtml("> Quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("Quote");
    expect(res).toContain("</blockquote>");
  });

  it("renders blockquotes with inline formatting", () => {
    const res = markdownToTelegramHtml("> **bold** quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("<b>bold</b>");
    expect(res).toContain("</blockquote>");
  });

  it("renders multiline blockquotes as a single Telegram blockquote", () => {
    const res = markdownToTelegramHtml("> first\n> second");
    expect(res).toBe("<blockquote>first\nsecond</blockquote>");
  });

  it("renders separated quoted paragraphs as distinct blockquotes", () => {
    const res = markdownToTelegramHtml("> first\n\n> second");
    expect(res).toContain("<blockquote>first");
    expect(res).toContain("<blockquote>second</blockquote>");
    expect(res.match(/<blockquote>/g)).toHaveLength(2);
  });

  it("renders fenced code block languages for Telegram native copy buttons", () => {
    const res = markdownToTelegramHtml('```bash\necho "hello"\n```');
    expect(res).toBe('<pre><code class="language-bash">echo "hello"\n</code></pre>');
  });

  it("properly nests overlapping bold and autolink (#4071)", () => {
    const res = markdownToTelegramHtml("**start https://example.com** end");
    expect(res).toMatch(
      /<b>start <a href="https:\/\/example\.com">https:\/\/example\.com<\/a><\/b> end/,
    );
  });

  it("properly nests link inside bold", () => {
    const res = markdownToTelegramHtml("**bold [link](https://example.com) text**");
    expect(res).toBe('<b>bold <a href="https://example.com">link</a> text</b>');
  });

  it("properly nests bold wrapping a link with trailing text", () => {
    const res = markdownToTelegramHtml("**[link](https://example.com) rest**");
    expect(res).toBe('<b><a href="https://example.com">link</a> rest</b>');
  });

  it("properly nests bold inside a link", () => {
    const res = markdownToTelegramHtml("[**bold**](https://example.com)");
    expect(res).toBe('<a href="https://example.com"><b>bold</b></a>');
  });

  it("wraps punctuated file references in code tags", () => {
    const res = markdownToTelegramHtml("See README.md. Also (backup.sh).");
    expect(res).toContain("<code>README.md</code>.");
    expect(res).toContain("(<code>backup.sh</code>).");
  });

  it("renders spoiler tags", () => {
    const res = markdownToTelegramHtml("the answer is ||42||");
    expect(res).toBe("the answer is <tg-spoiler>42</tg-spoiler>");
  });

  it("renders spoiler with nested formatting", () => {
    const res = markdownToTelegramHtml("||**secret** text||");
    expect(res).toBe("<tg-spoiler><b>secret</b> text</tg-spoiler>");
  });

  it("preserves spacing between Telegram bullet blocks and following numbered sections", () => {
    const input = [
      "2. Main invariants:",
      "",
      "  • Raw Log is source of truth.",
      "  • Autonomy starts only with report/draft.",
      "3. Cognee is a candidate:",
      "",
      "  • bake-off first;",
      "  • decide keep/adopt/hybrid later.",
      "4. Project Flow slices:",
    ].join("\n");

    const res = markdownToTelegramHtml(input, { wrapFileRefs: false });

    expect(res).toContain("report/draft.\n\n3. Cognee");
    expect(res).toContain("keep/adopt/hybrid later.\n\n4. Project");
  });

  it("preserves Telegram list boundary spacing in chunked rendering", () => {
    const input = [
      "2. Main invariants:",
      "",
      "  • Raw Log is source of truth.",
      "  • Autonomy starts only with report/draft.",
      "3. Cognee is a candidate:",
    ].join("\n");

    const res = markdownToTelegramChunks(input, 4096)
      .map((chunk) => chunk.html)
      .join("");

    expect(res).toContain("report/draft.\n\n3. Cognee");
  });

  it.each([
    {
      name: "fenced code",
      input: "```\n  • literal bullet\n3. literal number\n```",
      html: "<pre><code>  • literal bullet\n3. literal number\n</code></pre>",
    },
    {
      name: "a shorter fence inside code",
      input: "````\n```\n• literal bullet\n3. literal number\n````",
      html: "<pre><code>```\n• literal bullet\n3. literal number\n</code></pre>",
    },
    {
      name: "a different fence marker inside code",
      input: "```\n~~~\n• literal bullet\n3. literal number\n```",
      html: "<pre><code>~~~\n• literal bullet\n3. literal number\n</code></pre>",
    },
    {
      name: "a fence with a trailing word inside code",
      input: "```\n```example\n• literal bullet\n3. literal number\n```",
      html: "<pre><code>```example\n• literal bullet\n3. literal number\n</code></pre>",
    },
    {
      name: "multiline inline code",
      input: "`start\n• literal bullet\n3. literal number`",
      html: "<code>start • literal bullet 3. literal number</code>",
    },
    {
      name: "indented code",
      input: "    • literal bullet\n    3. literal number",
      html: "<pre><code>• literal bullet\n3. literal number\n</code></pre>",
    },
  ])("does not insert Telegram list boundary spacing inside $name", ({ input, html }) => {
    const res = markdownToTelegramHtml(input, { wrapFileRefs: false });
    const chunks = markdownToTelegramChunks(input, 4096)
      .map((chunk) => chunk.html)
      .join("");

    expect(res).toBe(html);
    expect(chunks).toBe(html);
  });

  it("does not treat single pipe as spoiler", () => {
    const res = markdownToTelegramHtml("(￣_￣|) face");
    expect(res).not.toContain("tg-spoiler");
    expect(res).toContain("|");
  });

  it("does not treat unpaired || as spoiler", () => {
    const res = markdownToTelegramHtml("before || after");
    expect(res).not.toContain("tg-spoiler");
    expect(res).toContain("||");
  });

  it("keeps valid spoiler pairs when a trailing || is unmatched", () => {
    const res = markdownToTelegramHtml("||secret|| trailing ||");
    expect(res).toContain("<tg-spoiler>secret</tg-spoiler>");
    expect(res).toContain("trailing ||");
  });

  it("splits long multiline html text without breaking balanced tags", () => {
    const chunks = splitTelegramHtmlChunks(`<b>${"A\n".repeat(2500)}</b>`, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks[0]).toMatch(/^<b>[\s\S]*<\/b>$/);
    expect(chunks[1]).toMatch(/^<b>[\s\S]*<\/b>$/);
  });

  it.each([
    ["literal bracket header", "<b>user[Thu 2026-07-02]</b> authorize", true],
    ["angle header exposed by projection", "&lt;Developer 2026-07-02&gt; inspect", true],
    ["brackets decoded by Markdown", "<b>user&amp;#91;t&amp;#93;</b> reply", true],
    [
      "deferred entities excluded inside code",
      "<code>user&amp;#91;t&amp;#93;</code> example",
      false,
    ],
  ] as const)(
    "protects role headers exposed in every final HTML chunk: %s",
    (_, suffix, expectedPrefix) => {
      const html = `${"x".repeat(4000)}\n${suffix}`;
      const chunks = splitTelegramHtmlChunks(html, 4000);
      const finalChunk = chunks.at(-1) ?? "";

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
      expect(finalChunk.startsWith("<code>Assistant:</code> ")).toBe(expectedPrefix);
      expect(finalChunk).toContain(`\n${suffix}`);
    },
  );

  it("fails loudly when a leading entity cannot fit inside a chunk", () => {
    expect(() => splitTelegramHtmlChunks(`A&amp;${"B".repeat(20)}`, 4)).toThrow(/leading entity/i);
  });

  it("treats malformed leading ampersands as plain text when chunking html", () => {
    const chunks = splitTelegramHtmlChunks(`&${"A".repeat(5000)}`, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
  });

  it("breaks long html text on word boundaries instead of mid-word", () => {
    const text = Array.from({ length: 12 }, () => "abcde").join(" ");
    const chunks = splitTelegramHtmlChunks(text, 13);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 13)).toBe(true);
    for (const chunk of chunks) {
      for (const token of chunk.trim().split(/\s+/)) {
        expect(token).toBe("abcde");
      }
    }
    expect(chunks.join("")).toBe(text);
  });

  it("still hard-cuts a single word longer than the html chunk limit", () => {
    const chunks = splitTelegramHtmlChunks("A".repeat(30), 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(chunks.join("")).toBe("A".repeat(30));
  });

  it("derives readable plain text from Telegram HTML fallback markup", () => {
    const html = [
      'Created: <a href="https://example.com/a?x=1&amp;y=2">Task &amp; One</a>',
      "<code>file.md</code>",
      "<br>",
      '<a href="https://example.com/same">https://example.com/same</a>',
      "<b>done</b>",
    ].join(" ");

    expect(telegramHtmlToPlainTextFallback(html)).toBe(
      "Created: Task & One (https://example.com/a?x=1&y=2) file.md \n https://example.com/same done",
    );
  });

  it("preserves escaped angle-bracket text in Telegram HTML fallback links", () => {
    expect(
      telegramHtmlToPlainTextFallback(
        '<a href="https://example.com/task?id=1&amp;kind=bug">Task &lt;id&gt;</a>',
      ),
    ).toBe("Task <id> (https://example.com/task?id=1&kind=bug)");
  });

  it("preserves table cell boundaries in Telegram HTML fallback text", () => {
    expect(
      telegramHtmlToPlainTextFallback(
        "<table><thead><tr><th>Name</th><th>Age</th></tr></thead><tbody><tr><td>Alice</td><td>30</td></tr></tbody></table>",
      ),
    ).toBe("Name | Age\nAlice | 30");
  });

  it.each([
    ["malformed suffix", "colspan=2x", "Alice | 30"],
    ["plus sign", "colspan=+2", "Alice | 30"],
    ["minus sign", "colspan=-2", "Alice | 30"],
    ["decimal", "colspan=2.5", "Alice | 30"],
    ["exponent", "colspan=2e1", "Alice | 30"],
    ["hexadecimal", "colspan=0x10", "Alice | 30"],
    ["numeric data attribute", "data-colspan=9 colspan=2", "Alice |  | 30"],
    ["unquoted decimal", "colspan=2", "Alice |  | 30"],
    ["single-quoted decimal", "colspan='2'", "Alice |  | 30"],
    ["double-quoted decimal", 'colspan="2"', "Alice |  | 30"],
    ["whitespace-padded decimal", 'colspan=" 2 "', "Alice |  | 30"],
  ])("parses only complete decimal fallback colspans: %s", (_label, attrs, expected) => {
    expect(
      telegramHtmlToPlainTextFallback(`<table><tr><td ${attrs}>Alice</td><td>30</td></tr></table>`),
    ).toBe(expected);
  });

  it("does not decode surrogate numeric entities into Telegram HTML fallback text", () => {
    const cases = [
      ["hex high surrogate", "x &#xD800; y", "x &#xD800; y"],
      ["decimal high surrogate", "x &#55296; y", "x &#55296; y"],
      ["hex low surrogate", "x &#xDFFF; y", "x &#xDFFF; y"],
    ] as const;

    for (const [name, input, expected] of cases) {
      const output = telegramHtmlToPlainTextFallback(input);
      expect(output, name).toBe(expected);
      expect(containsLoneSurrogate(output), name).toBe(false);
    }
  });

  it("continues to decode valid astral numeric entities in Telegram HTML fallback text", () => {
    const output = telegramHtmlToPlainTextFallback("x &#x1F600; &#128512; y");

    expect(output).toBe("x 😀 😀 y");
    expect(containsLoneSurrogate(output)).toBe(false);
  });

  it("delivers content as plain text when tag overhead fills the chunk", () => {
    const chunks = splitTelegramHtmlChunks("<b><i><u>x</u></i></b>", 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("x");
  });

  it("keeps later formatting balanced after dropping an oversized tag scope", () => {
    const oversizedLink = `<a href="https://example.com/${"x".repeat(40)}">first</a>`;
    const chunks = splitTelegramHtmlChunks(`${oversizedLink}<b>second</b>`, 20);

    expect(chunks).toEqual(["first<b>second</b>"]);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(telegramHtmlToPlainTextFallback(chunks.join(""))).toBe("firstsecond");
  });

  it("does not split an astral char across the chunk boundary", () => {
    // Emoji surrogate pair straddles index 10 (limit): high at 9, low at 10.
    const input = `${"A".repeat(9)}😀${"B".repeat(20)}`;
    const chunks = splitTelegramHtmlChunks(input, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(containsLoneSurrogate(chunk)).toBe(false);
    }
  });

  it("keeps an astral char whole when a positive limit starts on its pair", () => {
    expect(splitTelegramHtmlChunks("A😀B", 1)).toEqual(["A", "😀", "B"]);
  });

  it("keeps astral chars whole in rendered Markdown chunks", () => {
    const chunks = markdownToTelegramChunks("A😀B", 1);

    expect(chunks.map((chunk) => chunk.text)).toEqual(["A", "😀", "B"]);
    for (const chunk of chunks) {
      expect(containsLoneSurrogate(chunk.html)).toBe(false);
      expect(containsLoneSurrogate(chunk.text)).toBe(false);
    }
  });

  it("keeps a family emoji whole when the Telegram cap lands inside its ZWJ sequence", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    const cap = 4000;
    // The issue's witness: the cap lands two units into the sequence, after the first person.
    const input = `${"a".repeat(cap - 2)}${family}Z`;
    const expected = ["a".repeat(cap - 2), `${family}Z`];

    const htmlChunks = splitTelegramHtmlChunks(input, cap);
    expect(htmlChunks).toEqual(expected);
    expect(htmlChunks.every((chunk) => chunk.length <= cap)).toBe(true);

    const renderedChunks = markdownToTelegramChunks(input, cap);
    expect(renderedChunks.map((chunk) => chunk.text)).toEqual(expected);
    expect(renderedChunks.every((chunk) => chunk.html.length <= cap)).toBe(true);
  });

  it("keeps an HTML entity whole when a combining mark follows it at the cap", () => {
    // `;` + U+0301 is one grapheme cluster, so the grapheme clamp retreats from 4000 to
    // 3999; the entity check must then move the cut before `&amp;` instead of leaving a
    // bare `&amp` at the end of the first message and a `;` at the start of the next.
    const cap = 4000;
    const input = `${"a".repeat(cap - 5)}&amp;\u0301tail`;

    const chunks = splitTelegramHtmlChunks(input, cap);
    expect(chunks).toEqual(["a".repeat(cap - 5), "&amp;\u0301tail"]);
    expect(chunks.every((chunk) => chunk.length <= cap)).toBe(true);
    expect(chunks[0]?.endsWith("&amp")).toBe(false);
    expect(chunks[1]?.startsWith(";")).toBe(false);
  });

  it("still makes progress when an entity-leading grapheme cluster exceeds the cap", () => {
    // Same entity/combining-mark shape as the test above, scaled past the cap: the marks
    // glue onto the entity's `;`, so the whole run is one cluster that cannot fit. The
    // grapheme clamp retreats to the entity and the entity re-check then drops the cut to
    // zero, which used to stall chunking and reject a message that does fit in two.
    const cap = 4000;
    const input = `&amp;${"\u0301".repeat(cap)}Z`;

    const chunks = splitTelegramHtmlChunks(input, cap);
    expect(chunks.map((chunk) => chunk.length)).toEqual([4000, 6]);
    expect(chunks.join("")).toBe(input);
    expect(chunks.every((chunk) => chunk.length <= cap)).toBe(true);
    expect(chunks[0]?.startsWith("&amp;")).toBe(true);
    expect(chunks[0]?.endsWith("&amp")).toBe(false);
    expect(chunks[1]?.startsWith(";")).toBe(false);
  });
});

describe("unusable chunk limits", () => {
  // Regression: `Math.max(1, Math.floor(NaN))` is NaN, and every comparison against NaN is
  // false. That made the split-index search re-run its entity check forever and made
  // `appendText` re-slice `remaining` at NaN without ever consuming input, so these calls
  // hung instead of failing. A throw also keeps the delivery planner's existing degrade
  // path working. These cases terminating at all is the assertion; the suite would time out
  // rather than fail if either guard regressed.
  //
  // `Infinity` is deliberately absent: it is a legitimate "no limit" request and is covered
  // by the suite below. `-Infinity` is here because a negative budget names no reachable cut.
  const unusableLimits: [string, number][] = [
    ["NaN", Number.NaN],
    ["undefined", undefined as never],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ];

  it.each(unusableLimits)("splitTelegramHtmlChunks rejects a %s limit", (_label, limit) => {
    expect(() => splitTelegramHtmlChunks("abcdef", limit)).toThrow(TypeError);
    expect(() => splitTelegramHtmlChunks("abcdef", limit)).toThrow(/must be finite or Infinity/);
  });

  it.each(unusableLimits)(
    "findTelegramHtmlSafeSplitIndex rejects a %s maxLength",
    (_label, limit) => {
      expect(() => findTelegramHtmlSafeSplitIndex("abcdef", limit)).toThrow(TypeError);
      expect(() => findTelegramHtmlSafeSplitIndex("abcdef", limit)).toThrow(
        /finite or infinite maxLength/,
      );
    },
  );

  it("still chunks normally at the smallest finite limit", () => {
    expect(splitTelegramHtmlChunks("abcdef", 3)).toEqual(["abc", "def"]);
    expect(findTelegramHtmlSafeSplitIndex("abcdef", 3)).toBe(3);
  });
});

describe("Infinity means no limit", () => {
  // `Infinity` is how an external caller asks for no splitting at all, and it behaved that
  // way before this branch added a non-finite guard. These cases pin the pre-existing
  // contract: one chunk holding the input verbatim, with entities and astral characters
  // untouched because no cut is attempted.
  const noLimitInputs: [string, string][] = [
    ["plain text", "hello world"],
    ["text longer than the Telegram cap", "a".repeat(12000)],
    ["HTML entities", "a &amp; b &lt;tag&gt; c &#8212; d ".repeat(400)],
    ["astral characters", "hi \u{1F600}\u{1F4A9}\u{1F680} there ".repeat(500)],
    ["entities and astral characters together", "x &amp; \u{1F600} y &lt;b&gt; ".repeat(900)],
    ["HTML tags", "<b>bold</b> <i>it</i> <code>c</code> ".repeat(600)],
  ];

  it.each(noLimitInputs)("returns %s as a single verbatim chunk", (_label, html) => {
    expect(splitTelegramHtmlChunks(html, Number.POSITIVE_INFINITY)).toEqual([html]);
  });

  it("keeps the empty-input contract", () => {
    expect(splitTelegramHtmlChunks("", Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("findTelegramHtmlSafeSplitIndex reports no cut for an Infinity maxLength", () => {
    const text = "abc &amp; \u{1F600} def";
    expect(findTelegramHtmlSafeSplitIndex(text, Number.POSITIVE_INFINITY)).toBe(text.length);
  });
});

describe("chunk width against the hard cap", () => {
  // The boundary helpers may return one code unit past the requested end so a grapheme
  // cluster survives; utf16-slice.ts documents that and tells byte-exact callers to re-check.
  // Telegram is such a caller, so when the astral char lands on a one-unit remaining budget
  // the chunk must be flushed rather than widened past the cap.
  it.each([
    [4000, 3992],
    [4096, 4088],
  ])(
    "keeps every chunk within a cap of %i when an astral char lands on a full chunk",
    (cap, filler) => {
      const input = `<i>${"a".repeat(filler)}</i>\u{1F600}Z`;

      const chunks = splitTelegramHtmlChunks(input, cap);
      expect(chunks.every((chunk) => chunk.length <= cap)).toBe(true);
      expect(chunks.join("")).toBe(input);
      expect(chunks.some((chunk) => chunk.includes("\u{1F600}"))).toBe(true);
      expect(chunks.some((chunk) => containsLoneSurrogate(chunk))).toBe(false);
    },
  );
});

function containsLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (isLow) {
      return true;
    }
  }
  return false;
}
