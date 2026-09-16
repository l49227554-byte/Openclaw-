import { ChannelType, PermissionFlagsBits } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleDiscordMessageAction } from "./handle-action.js";

type FetchChannelInfoDiscord = typeof import("../send.js").fetchChannelInfoDiscord;

const {
  editChannelDiscord,
  fetchChannelInfoDiscord,
  grantedPermissions,
  hasAnyChannelPermissionDiscord,
  threadInfo,
} = vi.hoisted(() => {
  const permissions = new Set<bigint>();
  const thread = (locked = false): Awaited<ReturnType<FetchChannelInfoDiscord>> => ({
    id: "T1",
    type: ChannelType.GuildPublicThread,
    name: "archived-thread",
    guild_id: "G1",
    thread_metadata: {
      archived: true,
      auto_archive_duration: 1440,
      archive_timestamp: "2026-09-16T00:00:00.000Z",
      locked,
    },
  });
  return {
    editChannelDiscord: vi.fn(async () => ({ id: "T1" })),
    fetchChannelInfoDiscord: vi.fn<FetchChannelInfoDiscord>(async () => thread()),
    hasAnyChannelPermissionDiscord: vi.fn(
      async (
        _guildId: string,
        _channelId: string,
        _senderUserId: string,
        requiredPermissions: bigint[],
      ) => requiredPermissions.some((permission) => permissions.has(permission)),
    ),
    grantedPermissions: permissions,
    threadInfo: thread,
  };
});

vi.mock("../send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.js")>()),
  editChannelDiscord,
  fetchChannelInfoDiscord,
  hasAnyChannelPermissionDiscord,
}));

const cfg = {
  channels: { discord: { token: "token", groupPolicy: "open" } },
} as OpenClawConfig;

function runReopen(params: Record<string, unknown> = {}) {
  return handleDiscordMessageAction({
    action: "channel-edit",
    params: { channelId: "T1", archived: false, ...params },
    cfg,
    requesterSenderId: "sender-1",
    toolContext: { currentChannelProvider: "discord" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  grantedPermissions.clear();
  grantedPermissions.add(PermissionFlagsBits.SendMessages);
  fetchChannelInfoDiscord.mockResolvedValue(threadInfo());
});

describe("registered Discord channel-edit thread permissions", () => {
  it("allows an unlocked thread reopen with SendMessages", async () => {
    await expect(runReopen()).resolves.toMatchObject({ details: { ok: true } });

    expect(hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "G1",
      "T1",
      "sender-1",
      [PermissionFlagsBits.ManageThreads, PermissionFlagsBits.SendMessages],
      { cfg },
    );
    expect(editChannelDiscord).toHaveBeenCalled();
  });

  it("does not treat SendMessagesInThreads as reopen permission", async () => {
    grantedPermissions.clear();
    grantedPermissions.add(PermissionFlagsBits.SendMessagesInThreads);

    await expect(runReopen()).rejects.toThrow(/required permissions/);
    expect(hasAnyChannelPermissionDiscord.mock.calls[0]?.[3]).toEqual([
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.SendMessages,
    ]);
    expect(editChannelDiscord).not.toHaveBeenCalled();
  });

  it.each([
    ["an explicit unlock", { locked: false }],
    ["an explicit flag edit", { nsfw: false }],
    ["an explicit parent clear", { clearParent: true }],
  ])("keeps ManageThreads required for %s during reopen", async (_label, params) => {
    await expect(runReopen(params)).rejects.toThrow(/required permissions/);

    expect(hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "G1",
      "T1",
      "sender-1",
      [PermissionFlagsBits.ManageThreads],
      { cfg },
    );
    expect(editChannelDiscord).not.toHaveBeenCalled();
  });

  it("keeps ManageThreads required to reopen a locked thread", async () => {
    fetchChannelInfoDiscord.mockResolvedValue(threadInfo(true));

    await expect(runReopen()).rejects.toThrow(/required permissions/);
    expect(hasAnyChannelPermissionDiscord.mock.calls[0]?.[3]).toEqual([
      PermissionFlagsBits.ManageThreads,
    ]);
    expect(editChannelDiscord).not.toHaveBeenCalled();
  });
});
