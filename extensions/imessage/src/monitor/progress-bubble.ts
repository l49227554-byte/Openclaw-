// Narrated progress bubble for iMessage: one persistent "working on it…"
// bubble per turn, kept current by editing it in place as utility-model
// narration updates arrive. iMessage cannot stream a draft, so this is the
// channel's equivalent of Discord's progress draft: low-chatter (one bubble,
// not one per tool call), threading-preserving, and always replaced by the
// final reply.
//
// Editing is budgeted by Messages itself (5 edits per message, 15-minute
// window), so the bubble rotates to a fresh message when the edit budget
// runs low, the window ages out, or an edit fails.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createIMessageRpcClient, type IMessageRpcClient } from "../client.js";
import { resolveIMessageRemoteHost } from "../remote-host.js";
import { sendMessageIMessage } from "../send.js";

// Leave one edit of headroom under Messages' 5-edit cap; the fifth is kept
// for the operator-facing failure/rotation path.
const MAX_EDITS_PER_BUBBLE = 4;
// Messages allows edits for 15 minutes after send; rotate before the window
// closes so a late narration update never fails against an expired bubble.
const EDIT_WINDOW_MS = 14 * 60_000;
const PROGRESS_BUBBLE_PREFIX = "… ";
const PROGRESS_BUBBLE_MAX_CHARS = 700;
const PROGRESS_RPC_TIMEOUT_MS = 20_000;

export type IMessageProgressBubble = {
  /** Push the latest narration text into the turn's progress bubble. */
  update: (text: string) => Promise<void>;
  /** Stop the turn: no further bubble updates without aborting in-flight RPC. */
  stop: () => void;
  /** Retract the turn's bubble (used when the final reply supersedes it). */
  dispose: () => Promise<void>;
};

type ProgressBubbleParams = {
  cfg: OpenClawConfig;
  accountId?: string;
  /** Delivery target (handle or chat identifier) used for the send. */
  target: string;
  /** GUID of the inbound message the turn is working on; threading the
   *  bubble as a reply keeps it visually attached to that message (in group
   *  chats an unthreaded bubble reads as the response itself, and later
   *  human replies anchor to it). */
  replyToId?: string;
  runtime: RuntimeEnv;
};

function clampProgressText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= PROGRESS_BUBBLE_MAX_CHARS) {
    return cleaned;
  }
  return `${cleaned.slice(0, PROGRESS_BUBBLE_MAX_CHARS - 3).trimEnd()}...`;
}

function resolveSentBubbleGuid(result: { guid?: string; messageId: string }): string | undefined {
  const guid = result.guid?.trim();
  if (guid) {
    return guid;
  }
  const messageId = result.messageId?.trim();
  // Sends without bridge confirmation fall back to placeholders ("ok");
  // editing requires a concrete message guid.
  return messageId && !/^(ok|unknown)$/i.test(messageId) ? messageId : undefined;
}

export function createIMessageProgressBubble(params: ProgressBubbleParams): IMessageProgressBubble {
  const { cfg, accountId, target, replyToId, runtime } = params;
  const cliPath = "imsg";
  let client: IMessageRpcClient | undefined;
  let clientPromise: Promise<IMessageRpcClient> | undefined;
  let bubbleGuid: string | undefined;
  // The chat scope edits/unsend must address; captured from the send result
  // because a bare handle target does not name the conversation.
  let bubbleChatGuid: string | undefined;
  let bubbleSentAtMs = 0;
  let editCount = 0;
  let stopped = false;
  let lastText = "";
  // Serialize send/edit/unsend so a slow bridge cannot interleave an edit for
  // an old bubble with the rotation send for a new one.
  let chain: Promise<void> = Promise.resolve();

  const log = (message: string) => runtime.log?.(`imessage progress bubble: ${message}`);

  const getClient = async (): Promise<IMessageRpcClient> => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const remoteHost = await resolveIMessageRemoteHost({ cliPath });
        return await createIMessageRpcClient({ cliPath, remoteHost });
      })();
    }
    return await clientPromise;
  };

  const sendBubble = async (text: string): Promise<void> => {
    const sent = await sendMessageIMessage(target, text, {
      config: cfg,
      ...(accountId ? { accountId } : {}),
      ...(replyToId ? { replyToId } : {}),
    });
    const guid = resolveSentBubbleGuid(sent);
    if (!guid) {
      throw new Error("progress bubble send returned no message guid");
    }
    bubbleGuid = guid;
    bubbleChatGuid = sent.chatGuid?.trim() || bubbleChatGuid;
    bubbleSentAtMs = Date.now();
    editCount = 0;
  };

  const unsendBubble = async (guid: string): Promise<void> => {
    try {
      const rpc = await getClient();
      await rpc.request(
        "message.unsend",
        { chat_guid: bubbleChatGuid ?? target, message_id: guid },
        { timeoutMs: PROGRESS_RPC_TIMEOUT_MS },
      );
    } catch (err) {
      log(`unsend failed for ${guid}: ${String(err)}`);
    }
  };

  const rotate = async (text: string): Promise<void> => {
    const staleGuid = bubbleGuid;
    bubbleGuid = undefined;
    if (staleGuid) {
      await unsendBubble(staleGuid);
    }
    await sendBubble(text);
  };

  const update = async (text: string): Promise<void> => {
    if (stopped) {
      return;
    }
    const nextText = clampProgressText(text);
    if (!nextText || nextText === lastText) {
      return;
    }
    const run = chain.then(async () => {
      if (stopped) {
        return;
      }
      const displayText = `${PROGRESS_BUBBLE_PREFIX}${nextText}`;
      try {
        if (!bubbleGuid) {
          await sendBubble(displayText);
          lastText = nextText;
          return;
        }
        const windowExpired = Date.now() - bubbleSentAtMs > EDIT_WINDOW_MS;
        if (windowExpired || editCount >= MAX_EDITS_PER_BUBBLE) {
          await rotate(displayText);
          lastText = nextText;
          return;
        }
        const rpc = await getClient();
        await rpc.request(
          "message.edit",
          {
            chat_guid: bubbleChatGuid ?? target,
            message_id: bubbleGuid,
            text: displayText,
            backwards_compatibility_message: displayText,
            part_index: 0,
          },
          { timeoutMs: PROGRESS_RPC_TIMEOUT_MS },
        );
        editCount += 1;
        lastText = nextText;
      } catch (err) {
        // A failed edit (expired window, retracted bubble, bridge hiccup)
        // must not wedge the turn: fall back to a fresh bubble.
        log(`edit failed, rotating: ${String(err)}`);
        try {
          await sendBubble(displayText);
          lastText = nextText;
        } catch (sendErr) {
          log(`rotation send also failed: ${String(sendErr)}`);
        }
      }
    });
    chain = run.catch(() => {});
    await run;
  };

  const stop = () => {
    stopped = true;
  };

  const dispose = async (): Promise<void> => {
    stopped = true;
    // Let any queued update settle before reading the guid: a rotation that
    // lands while dispose waits sends a NEW bubble, and snapshotting first
    // would orphan it (the 08:14 leak). The stopped flag keeps it from
    // sending anything after this point.
    await chain.catch(() => {});
    const guid = bubbleGuid;
    bubbleGuid = undefined;
    if (guid) {
      await unsendBubble(guid);
    }
    await client?.stop().catch(() => {});
    client = undefined;
    clientPromise = undefined;
  };

  return { update, stop, dispose };
}
