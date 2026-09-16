import { describe, expect, it } from "vitest";
import { getCommandDetection, listNativeCommandSpecs } from "../commands-registry.js";
import { isDirectiveOnly } from "./directive-handling.directive-only.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

describe("model shortcuts", () => {
  it.each([
    ["/luna", "openai/gpt-5.6-luna", "max"],
    ["/sol", "openai/gpt-5.6-sol", "medium"],
  ] as const)("routes %s through model and thinking directives", (command, model, effort) => {
    const parsed = parseInlineSessionDirectives(command);
    expect(parsed).toMatchObject({
      cleaned: "",
      hasModelDirective: true,
      rawModelDirective: model,
      hasThinkDirective: true,
      thinkLevel: effort,
    });
    expect(
      isDirectiveOnly({
        directives: parsed,
        cleanedBody: parsed.cleaned,
        ctx: {},
        cfg: {},
        isGroup: false,
      }),
    ).toBe(true);
    expect(getCommandDetection().exact.has(command)).toBe(true);
    expect(listNativeCommandSpecs().some((spec) => spec.name === command.slice(1))).toBe(false);
  });

  it("requires an exact standalone command", () => {
    for (const body of ["/lunar", "/sol more", "please /luna"]) {
      const parsed = parseInlineSessionDirectives(body);
      expect(parsed.hasModelDirective).toBe(false);
      expect(parsed.hasThinkDirective).toBe(false);
    }
  });
});
