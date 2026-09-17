// Shared Slack ingress lifecycle contract; no monitor runtime dependencies.
import type { ChannelIngressMonitorLifecycle } from "openclaw/plugin-sdk/channel-outbound";

export type SlackIngressTurnLifecycle = Omit<
  ChannelIngressMonitorLifecycle,
  "onAdoptionFinalizing"
> & {
  onSessionRouted?: (sessionKey: string) => Promise<void>;
  /** A logical duplicate awaits its existing owner before session routing. */
  onDispatchWaiting?: () => void;
};
