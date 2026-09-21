import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { isToolCallXmlArtifact } from "./tool-call-xml.js";

const invocation = '<invoke name="example"><parameter name="value">a</parameter></invoke>';

describe("complete tool-call XML artifacts", () => {
  it.each([
    invocation,
    `${invocation}\n${invocation}`,
    `<function_calls>${invocation}</function_calls>`,
    '<antml:function_calls><antml:invoke name="example"><antml:parameter name="value">a</antml:parameter></antml:invoke></antml:function_calls>',
    '<invoke name="example"><parameter name="value">a < b and <b>bold</b></parameter></invoke>',
    '<invoke name="example" note="a > b"><parameter name="value">a</parameter></invoke>',
  ])("recognizes an entire complete artifact: %s", (text) => {
    expect(isToolCallXmlArtifact(text)).toBe(true);
  });

  it.each([
    `Use ${invocation} in your prompt.`,
    '<invoke name="example">ordinary prose</invoke>',
    `${invocation}The answer is 42.${invocation}`,
    `    ${invocation}`,
    `\t${invocation}`,
    `<function_calls>${invocation}`,
    "<invoke><parameter>a</invoke>The answer is 42.<invoke><parameter>b</parameter></invoke>",
    "<invoke><parameter>a</antml:parameter></invoke>",
    "<invoke><parameter>a</parameter></invoke/>",
    '<invoke><parameter value="unterminated',
  ])("retains prose, code, or malformed envelopes: %s", (text) => {
    expect(isToolCallXmlArtifact(text)).toBe(false);
  });

  it("handles long sibling lists and missing close tags without regex backtracking", () => {
    const parameters = '<parameter name="value">a</parameter>'.repeat(1024);
    const started = performance.now();
    expect(isToolCallXmlArtifact(`<invoke name="example">${parameters}</invoke>`)).toBe(true);
    expect(isToolCallXmlArtifact(`<invoke name="example">${parameters}`)).toBe(false);
    expect(isToolCallXmlArtifact(`<invoke name="example">${parameters}</invoke>suffix`)).toBe(
      false,
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
