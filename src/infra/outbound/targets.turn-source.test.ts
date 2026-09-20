import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveHeartbeatDeliveryTarget } from "./targets.js";
import {
  createGenericTargetTestPlugin,
  createTargetsTestRegistry,
} from "./targets.test-helpers.js";

describe("resolveHeartbeatDeliveryTarget turnSource routing (#153543)", () => {
  const previousRegistry = getActivePluginRegistry();

  afterEach(() => {
    setActivePluginRegistry(previousRegistry);
  });

  it("delivers origin-carrying event wakes to event origin instead of explicit heartbeat target (#153543)", () => {
    const discord = createGenericTargetTestPlugin("discord", "Discord");
    const feishu = createGenericTargetTestPlugin("feishu", "Feishu");
    setActivePluginRegistry(createTargetsTestRegistry([feishu, discord]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {
        agents: {
          defaults: {
            heartbeat: {
              target: "feishu",
              to: "user:ou_feishu_owner",
            },
          },
        },
      } as OpenClawConfig,
      entry: {
        sessionId: "sess-discord-direct",
        updatedAt: 1,
        lastChannel: "discord",
        lastTo: "557519782434308115",
        chatType: "direct",
      },
      heartbeat: {
        target: "feishu",
        to: "user:ou_feishu_owner",
      },
      turnSource: {
        channel: "discord",
        to: "557519782434308115",
      },
    });

    expect(resolved).toMatchObject({ channel: "discord", to: "557519782434308115" });
  });

  it("delivers scheduled heartbeat to explicit target when no turnSource is present (#153543)", () => {
    const discord = createGenericTargetTestPlugin("discord", "Discord");
    const feishu = createGenericTargetTestPlugin("feishu", "Feishu");
    setActivePluginRegistry(createTargetsTestRegistry([feishu, discord]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {
        agents: {
          defaults: {
            heartbeat: {
              target: "feishu",
              to: "user:ou_feishu_owner",
            },
          },
        },
      } as OpenClawConfig,
      entry: {
        sessionId: "sess-discord-direct",
        updatedAt: 1,
        lastChannel: "discord",
        lastTo: "557519782434308115",
        chatType: "direct",
      },
      heartbeat: {
        target: "feishu",
        to: "user:ou_feishu_owner",
      },
    });

    expect(resolved).toMatchObject({ channel: "feishu", to: "user:ou_feishu_owner" });
  });

  it("never reuses an ambient group session route for originless owner delivery", () => {
    const discord = createGenericTargetTestPlugin("discord", "Discord");
    const telegram = createGenericTargetTestPlugin("telegram", "Telegram");
    setActivePluginRegistry(createTargetsTestRegistry([telegram, discord]));

    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {
        commands: {
          ownerAllowFrom: ["telegram:123456789"],
        },
        channels: {
          telegram: { allowFrom: ["123456789"] },
        },
        agents: {
          defaults: {
            heartbeat: {
              target: "owner",
            },
          },
        },
      } as OpenClawConfig,
      entry: {
        sessionId: "sess-discord-group",
        updatedAt: 1,
        lastChannel: "discord",
        lastTo: "channel:general-discussion",
        chatType: "group",
      },
      heartbeat: {
        target: "owner",
      },
      // No explicit turnSource on originless wake
    });

    // Must deliver to configured telegram owner, NEVER leaking into discord group
    expect(resolved).toMatchObject({ channel: "telegram", to: "123456789" });
    expect(resolved.channel).not.toBe("discord");
    expect(resolved.to).not.toBe("channel:general-discussion");
  });
});
