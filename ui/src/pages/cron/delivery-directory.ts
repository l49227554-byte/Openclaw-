import type { ConversationListItem, ConversationListResult } from "@openclaw/gateway-protocol";
import type { CronState } from "../../lib/cron/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";

export type CronDeliveryDirectoryHost = {
  /** The page state that currently owns the editor. */
  currentCronState: () => CronState;
  /** Admin access is revalidated per request because it can drop mid-flight. */
  canManage: () => boolean;
  captureConnection: () => GatewayConnectionScope | null;
  isCurrentConnection: (scope: GatewayConnectionScope) => boolean;
  /** Re-render the page for the state that published the change. */
  notify: (cronState: CronState) => void;
};

/**
 * Owns the Automations editor's recipient directory: the cached suggestions,
 * the published error, and the request generation. This state is page-owned
 * rather than CronState-owned, so a continuation that outlived the editor it
 * started in must prove ownership before clearing the cache or reading again.
 */
export class CronDeliveryDirectory {
  conversations: ConversationListItem[] = [];
  error: string | null = null;
  private requestId = 0;

  constructor(private readonly host: CronDeliveryDirectoryHost) {}

  /** Retire every in-flight read and drop the cached suggestions and error. */
  clear(cronState: CronState = this.host.currentCronState()) {
    this.requestId += 1;
    this.conversations = [];
    this.error = null;
    this.host.notify(cronState);
  }

  /**
   * A continuation owns the directory only while its page, its connection, and
   * its admin access all survive. Clearing the cache or advancing the
   * generation from a retired continuation would silently retire the
   * replacement editor's in-flight read instead.
   */
  ownedBy(cronState: CronState, connectionScope: GatewayConnectionScope | null): boolean {
    return (
      this.host.currentCronState() === cronState &&
      connectionScope !== null &&
      this.host.isCurrentConnection(connectionScope) &&
      this.host.canManage()
    );
  }

  async load(cronState: CronState = this.host.currentCronState()) {
    const requestId = ++this.requestId;
    this.conversations = [];
    this.error = null;
    this.host.notify(cronState);
    const client = cronState.client;
    const mode = cronState.cronForm.deliveryMode;
    const channel = cronState.cronForm.deliveryChannel.trim();
    const agentId = cronState.cronForm.agentId.trim() || cronState.cronAgentId?.trim() || "";
    if (
      !this.host.canManage() ||
      !client ||
      mode !== "announce" ||
      !agentId ||
      channel === "last"
    ) {
      return;
    }
    const connectionScope = this.host.captureConnection();
    if (!connectionScope) {
      return;
    }
    const isCurrent = () =>
      requestId === this.requestId && this.ownedBy(cronState, connectionScope);
    try {
      const result = await client.request<ConversationListResult>("conversations.list", {
        agentId,
        channel,
        limit: 100,
      });
      if (isCurrent()) {
        // The directory is bounded, so it is authoritative only as a source of
        // target suggestions. Never infer hidden account or topic routing from it.
        this.conversations = result.conversations;
        this.error = null;
        this.host.notify(cronState);
      }
    } catch (error) {
      if (isCurrent()) {
        this.conversations = [];
        this.error = `Could not load recipient suggestions: ${formatUiError(error)}`;
        this.host.notify(cronState);
      }
    }
  }
}
