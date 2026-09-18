// Telegram tests cover dice action runtime behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramAction, telegramActionRuntime } from "./action-runtime.js";

const originalTelegramActionRuntime = { ...telegramActionRuntime };
const requireRecord = createRequireRecord("object", "expected-label");

const sendDiceTelegram = vi.fn(
  async (_to: string, _emoji: string | undefined, _opts?: Record<string, unknown>) => ({
    messageId: "801",
    chatId: "123",
    emoji: "\u{1F3B2}",
    value: 4,
  }),
);

function telegramConfig(): OpenClawConfig {
  return { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
}

function rollDice(params: Record<string, unknown>) {
  return handleTelegramAction({ action: "dice", ...params }, telegramConfig(), {
    conversationReadOrigin: "direct-operator",
  });
}

describe("handleTelegramAction dice", () => {
  beforeEach(() => {
    sendDiceTelegram.mockClear();
    Object.assign(telegramActionRuntime, originalTelegramActionRuntime, { sendDiceTelegram });
  });

  afterEach(() => {
    Object.assign(telegramActionRuntime, originalTelegramActionRuntime);
  });

  it("forwards the silent option to a dice roll", async () => {
    // The shared schema accepts `silent` for dice and the sender supports it; dropping it
    // here made silent rolls notify recipients anyway.
    const result = await rollDice({
      to: "@testchannel",
      diceEmoji: "\u{1F3B2}",
      silent: true,
    });

    const call = sendDiceTelegram.mock.calls[0];
    if (!call) {
      throw new Error("Expected Telegram mock call: send dice");
    }
    expect(call[0]).toBe("@testchannel");
    expect(call[1]).toBe("\u{1F3B2}");
    const options = requireRecord(call[2], "send dice options");
    expect(options.silent).toBe(true);

    const details = requireRecord(result.details, "Telegram action details");
    expect(details.ok).toBe(true);
    expect(details.value).toBe(4);
  });

  it("rejects a roll when the send gate is disabled", async () => {
    // Dice rides the existing sendMessage gate; disabling sending must withdraw it.
    await expect(
      handleTelegramAction(
        { action: "dice", to: "@testchannel" },
        {
          channels: { telegram: { botToken: "tok", actions: { sendMessage: false } } },
        } as OpenClawConfig,
        { conversationReadOrigin: "direct-operator" },
      ),
    ).rejects.toThrow("Telegram sendMessage is disabled.");
    expect(sendDiceTelegram).not.toHaveBeenCalled();
  });
});
