import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionDeliveryState, SessionEntry } from "../../config/sessions/types.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveHeartbeatDeliveryTarget } from "./targets.js";
import {
  createGenericTargetTestPlugin,
  createTargetsTestRegistry,
  createTestChannelPlugin,
  telegramMessagingForTest,
} from "./targets.test-helpers.js";

function createOwnerAllowlistTargetTestPlugin(params: {
  id: ChannelPlugin["id"];
  label: string;
  ownerId: string;
  inferTargetChatType?: NonNullable<ChannelPlugin["messaging"]>["inferTargetChatType"];
}): ChannelPlugin {
  const plugin = createTestChannelPlugin({
    id: params.id,
    label: params.label,
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }) =>
        to
          ? { ok: true as const, to: to.trim() }
          : { ok: false as const, error: new Error("target required") },
    },
    messaging: {
      ...(params.inferTargetChatType ? { inferTargetChatType: params.inferTargetChatType } : {}),
      targetPrefixes: [String(params.id)],
      targetResolver: { looksLikeId: () => true },
    },
  });
  plugin.config = { ...plugin.config, resolveAllowFrom: () => [params.ownerId] };
  return plugin;
}

describe("resolveHeartbeatDeliveryTarget turnSource routing (#153543)", () => {
  const previousRegistry = getActivePluginRegistry();

  afterEach(() => {
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
    }
  });

  it("delivers origin-carrying event wakes to event origin instead of explicit heartbeat target (#153543)", () => {
    const discord = createGenericTargetTestPlugin("discord", "Discord");
    const feishu = createGenericTargetTestPlugin("feishu", "Feishu");
    setActivePluginRegistry(createTargetsTestRegistry([feishu, discord]));

    const directDelivery: SessionDeliveryState = {
      kind: "external",
      route: {
        channel: "discord",
        target: { to: "557519782434308115", chatType: "direct" },
      },
      context: {
        channel: "discord",
        to: "557519782434308115",
      },
      origin: {
        provider: "discord",
        to: "557519782434308115",
        chatType: "direct",
      },
    };

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
        chatType: "direct",
        delivery: directDelivery,
      } as unknown as SessionEntry,
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

    const directDelivery: SessionDeliveryState = {
      kind: "external",
      route: {
        channel: "discord",
        target: { to: "557519782434308115", chatType: "direct" },
      },
      context: {
        channel: "discord",
        to: "557519782434308115",
      },
      origin: {
        provider: "discord",
        to: "557519782434308115",
        chatType: "direct",
      },
    };

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
        chatType: "direct",
        delivery: directDelivery,
      } as unknown as SessionEntry,
      heartbeat: {
        target: "feishu",
        to: "user:ou_feishu_owner",
      },
    });

    expect(resolved).toMatchObject({ channel: "feishu", to: "user:ou_feishu_owner" });
  });

  it("never reuses an ambient group session route for originless owner delivery", () => {
    const discord = createGenericTargetTestPlugin("discord", "Discord");
    const telegram = createOwnerAllowlistTargetTestPlugin({
      id: "telegram",
      label: "Telegram",
      ownerId: "123456789",
      inferTargetChatType: telegramMessagingForTest.inferTargetChatType,
    });
    setActivePluginRegistry(createTargetsTestRegistry([telegram, discord]));

    const groupDelivery: SessionDeliveryState = {
      kind: "external",
      route: {
        channel: "discord",
        target: { to: "channel:general-discussion", chatType: "group" },
      },
      context: {
        channel: "discord",
        to: "channel:general-discussion",
      },
      origin: {
        provider: "discord",
        to: "channel:general-discussion",
        chatType: "group",
      },
    };

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
        chatType: "group",
        delivery: groupDelivery,
      } as unknown as SessionEntry,
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

  it("preserves configured explicit destination for scheduled work even when ambient session has another route", () => {
    const discord = createGenericTargetTestPlugin("discord", "Discord");
    const feishu = createGenericTargetTestPlugin("feishu", "Feishu");
    setActivePluginRegistry(createTargetsTestRegistry([feishu, discord]));

    const groupDelivery: SessionDeliveryState = {
      kind: "external",
      route: {
        channel: "discord",
        target: { to: "channel:general-discussion", chatType: "group" },
      },
      context: {
        channel: "discord",
        to: "channel:general-discussion",
      },
      origin: {
        provider: "discord",
        to: "channel:general-discussion",
        chatType: "group",
      },
    };

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
        sessionId: "sess-discord-group",
        updatedAt: 1,
        chatType: "group",
        delivery: groupDelivery,
      } as unknown as SessionEntry,
      heartbeat: {
        target: "feishu",
        to: "user:ou_feishu_owner",
      },
      // Scheduled work selects no unconsumed turnSource
      turnSource: undefined,
    });

    expect(resolved).toMatchObject({ channel: "feishu", to: "user:ou_feishu_owner" });
    expect(resolved.channel).not.toBe("discord");
    expect(resolved.to).not.toBe("channel:general-discussion");
  });
});


