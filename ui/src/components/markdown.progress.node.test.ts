// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { stripProgressCardRawContentBlocks } from "./markdown-raw-content.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

describe("progress-card markdown", () => {
  it("allows only progress markup when explicitly enabled", () => {
    const markdown =
      '<progress value="3" max="7" onclick="alert(1)"></progress><script>alert(2)</script>';

    const defaultHtml = toSanitizedMarkdownHtml(markdown);
    const progressHtml = toSanitizedMarkdownHtml(markdown, { progressBars: true });

    expect(defaultHtml).not.toContain("<progress");
    expect(progressHtml).toContain('<progress value="3" max="7"></progress>');
    expect(progressHtml).not.toContain("onclick");
    expect(progressHtml).not.toContain("<script");
    expect(progressHtml).not.toContain("alert(2)");
  });

  it("preserves raw-content block removal semantics", () => {
    const markdown =
      'before<SCRIPT data-test="true">alert(1)</script >' +
      "middle<style>body{display:none}</style><template>hidden</template>after";

    expect(stripProgressCardRawContentBlocks(markdown)).toBe("beforemiddleafter");
    expect(stripProgressCardRawContentBlocks("before<script>unfinished")).toBe(
      "before<script>unfinished",
    );
  });

  it("keeps raw-content preprocessing bounded for repeated unclosed tags", () => {
    const markdown = "<script>".repeat(17_500);
    const startedAt = performance.now();

    const progressHtml = toSanitizedMarkdownHtml(markdown, { progressBars: true });

    expect(progressHtml).not.toContain("<script");
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});
