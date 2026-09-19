// Verifies runtime channel capabilities derived from channel account config.
import { describe, expect, it } from "vitest";
import { collectRuntimeChannelCapabilities } from "./runtime-capabilities.js";

describe("collectRuntimeChannelCapabilities", () => {
  it("advertises markdown details only when the client handshake says so", () => {
    expect(collectRuntimeChannelCapabilities({ channel: "webchat" })).toBeUndefined();
    expect(
      collectRuntimeChannelCapabilities({
        channel: "webchat",
        clientCaps: ["markdown-details"],
      }),
    ).toEqual(["markdownDetails"]);
  });

  it("does not advertise markdown details for a plugin-less non-webchat channel", () => {
    expect(collectRuntimeChannelCapabilities({ channel: "heartbeat" })).toBeUndefined();
  });

  it("adds thread-bound spawn capabilities when the channel account allows unified spawns", () => {
    const capabilities = collectRuntimeChannelCapabilities({
      channel: "discord",
      accountId: "default",
      cfg: {
        session: {
          threadBindings: {
            spawnSessions: true,
          },
        },
      },
    });

    expect(capabilities).toEqual(["threadbound-subagent-spawn", "threadbound-acp-spawn"]);
  });

  it("omits thread-bound spawn capabilities when unified spawns are disabled", () => {
    const capabilities = collectRuntimeChannelCapabilities({
      channel: "discord",
      accountId: "default",
      cfg: {
        session: {
          threadBindings: {
            spawnSessions: false,
          },
        },
      },
    });

    expect(capabilities).toBeUndefined();
  });
});
