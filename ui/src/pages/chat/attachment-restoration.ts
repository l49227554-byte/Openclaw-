import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { generateUUID } from "../../lib/uuid.ts";

/** Restores durable first-turn payloads into visible, locked composer chips. */
export function restoreChatApiAttachments(attachments?: readonly unknown[]): ChatAttachment[] {
  if (!attachments?.length) {
    return [];
  }
  return attachments.flatMap((value) => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const attachment = value as Record<string, unknown>;
    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const content = typeof attachment.content === "string" ? attachment.content : "";
    if (
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(content)
    ) {
      return [];
    }
    return [
      {
        id: generateUUID(),
        dataUrl: `data:${mimeType};base64,${content}`,
        mimeType,
        fileName: typeof attachment.fileName === "string" ? attachment.fileName : undefined,
      },
    ];
  });
}
