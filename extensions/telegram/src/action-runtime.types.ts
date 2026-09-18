import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { TelegramMessageMutationContext } from "./message-topic-binding.js";

export type TelegramActionOptions = {
  mediaAccess?: ChannelMessageActionContext["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  sessionKey?: string | null;
  inboundEventKind?: string;
  gatewayClientScopes?: readonly string[];
  deliveryRetryOwner?: ChannelMessageActionContext["deliveryRetryOwner"];
  onPlatformSendDispatch?: ChannelMessageActionContext["onPlatformSendDispatch"];
  assertDirectAdapterHandoff?: ChannelMessageActionContext["assertDirectAdapterHandoff"];
  skipQueue?: boolean;
  conversationReadOrigin?: NonNullable<ChannelMessageActionContext["conversationReadOrigin"]>;
  requesterAccountId?: string | null;
  reply?: ChannelMessageActionContext["reply"];
  toolContext?: TelegramMessageMutationContext["toolContext"];
};
