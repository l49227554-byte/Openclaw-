import { describe, expect, it } from "vitest";
import {
  MODEL_SELECTION_EXTENSION_NAMESPACE,
  normalizeSessionModelSelection,
  resolveSessionModelSelectionFromExtensions,
} from "./model-selection.js";

describe("session model-selection projection", () => {
  it("accepts a supported mode and sanitizes decision metadata", () => {
    expect(
      normalizeSessionModelSelection({
        mode: "auto",
        recoveryHint: "Use /jev-router off",
        lastDecision: {
          model: "  openai/gpt-5.6-luna\n",
          reason: "complex \u0000 task",
          at: 1234,
          ignored: "not projected",
        },
      }),
    ).toEqual({
      mode: "auto",
      recoveryHint: "Use /jev-router off",
      lastDecision: {
        model: "openai/gpt-5.6-luna",
        reason: "complex task",
        at: 1234,
      },
    });
  });

  it("rejects invalid modes and invalid decision fields", () => {
    expect(
      normalizeSessionModelSelection({
        mode: "enabled",
        lastDecision: { model: "ignored", at: -1 },
      }),
    ).toBeUndefined();
    expect(
      normalizeSessionModelSelection({
        mode: "shadow",
        recoveryHint: "  recover\u0000 with the plugin\ncontrol  ",
        lastDecision: { model: "", reason: "\u0000", at: Number.NaN },
      }),
    ).toEqual({
      mode: "shadow",
      recoveryHint: "recover with the plugin control",
    });
  });

  it("projects only the active namespaced extension", () => {
    expect(
      resolveSessionModelSelectionFromExtensions([
        { namespace: "other", value: { mode: "auto" } },
        {
          namespace: MODEL_SELECTION_EXTENSION_NAMESPACE,
          value: {
            mode: "off",
            recoveryHint: "Use the plugin control",
            lastDecision: { model: "openai/gpt-5.6-sol" },
          },
        },
      ]),
    ).toEqual({
      mode: "off",
      recoveryHint: "Use the plugin control",
      lastDecision: { model: "openai/gpt-5.6-sol" },
    });
    expect(resolveSessionModelSelectionFromExtensions(undefined)).toBeUndefined();
  });
});
