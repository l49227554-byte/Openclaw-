// Telegram helper module supports account config behavior.
import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  mergeAccountConfig,
  normalizeAccountId,
  resolveNormalizedAccountEntry,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-core";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";

export function resolveTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig | undefined {
  const normalized = normalizeAccountId(accountId);
  return resolveNormalizedAccountEntry(
    cfg.channels?.telegram?.accounts,
    normalized,
    normalizeAccountId,
  );
}

export function hasTelegramAccountConfig(cfg: OpenClawConfig, accountId: string): boolean {
  const normalized = normalizeAccountId(accountId);
  if (resolveTelegramAccountConfig(cfg, normalized)) {
    return true;
  }
  const channel = cfg.channels?.telegram;
  if (normalized !== DEFAULT_ACCOUNT_ID && Object.keys(channel?.accounts ?? {}).length > 0) {
    return false;
  }
  return (
    hasConfiguredAccountValue(channel?.botToken) ||
    hasConfiguredAccountValue(channel?.tokenFile) ||
    (normalized === DEFAULT_ACCOUNT_ID && hasConfiguredAccountValue(process.env.TELEGRAM_BOT_TOKEN))
  );
}

export function mergeTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig {
  const channelConfig = cfg.channels?.telegram;
  // Empty groups retain their shipped single-account inheritance behavior;
  // multiple accounts can explicitly opt out with an empty map.
  const isMultiAccount = Object.keys(channelConfig?.accounts ?? {}).length > 1;
  return mergeAccountConfig<TelegramAccountConfig>({
    channelConfig,
    accountConfig: resolveTelegramAccountConfig(cfg, accountId),
    omitKeys: ["defaultAccount"],
    inheritEmptyKeys: { capabilities: "array", ...(isMultiAccount ? {} : { groups: "object" }) },
    preserveRootAllowFrom: true,
  });
}
