// Slack tests cover outbound text chunking at the message cap.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveSlackTextChunks } from "./send-text-chunks.js";

const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } } as OpenClawConfig;
const SLACK_CAP = 8000;
const FAMILY_EMOJI = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
// The issue's witness: the cap lands two units into the ZWJ sequence, after the first person.
const WITNESS = `${"a".repeat(SLACK_CAP - 2)}${FAMILY_EMOJI}Z`;

describe("resolveSlackTextChunks", () => {
  it("keeps a family emoji whole when preserved plain text is sliced at the Slack cap", () => {
    const chunks = resolveSlackTextChunks({
      cfg: SLACK_TEST_CFG,
      text: WITNESS,
      textLimit: SLACK_CAP,
      preservePlainText: true,
    });

    expect(chunks).toEqual(["a".repeat(SLACK_CAP - 2), `${FAMILY_EMOJI}Z`]);
    expect(chunks.every((chunk) => chunk.length <= SLACK_CAP)).toBe(true);
  });

  it("keeps a family emoji whole when rendered markdown is chunked at the Slack cap", () => {
    const chunks = resolveSlackTextChunks({
      cfg: SLACK_TEST_CFG,
      text: WITNESS,
      textLimit: SLACK_CAP,
    });

    expect(chunks).toEqual(["a".repeat(SLACK_CAP - 2), `${FAMILY_EMOJI}Z`]);
    expect(chunks.every((chunk) => chunk.length <= SLACK_CAP)).toBe(true);
  });
});
