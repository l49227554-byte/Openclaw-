import type { RealtimeVoiceBridgeSession } from "../../../talk/session-runtime.js";
import type { RelaySession } from "./state.js";

/** Owns the one-time opening after both provider and accepted-client readiness. */
export function createRelayOpeningGreeting(params: {
  greeting?: string;
  assertAllowed?: () => void;
  getActiveRelay: () => RelaySession | undefined;
  getBridge: () => RealtimeVoiceBridgeSession | undefined;
}) {
  let providerReady = false;
  let clientReady = false;
  let requested = false;
  const request = () => {
    const active = params.getActiveRelay();
    if (
      !params.greeting ||
      requested ||
      !providerReady ||
      !clientReady ||
      !active ||
      active.closing
    ) {
      return;
    }
    // Readiness can repeat; consume before checking retained authority or invoking
    // the provider. A revoked or failed greeting is never retried on a later frame.
    requested = true;
    try {
      params.assertAllowed?.();
      if (params.getActiveRelay() !== active || active.closing) {
        return;
      }
      if (Date.now() >= active.expiresAtMs) {
        throw new Error("Talk greeting session expired");
      }
      const bridge = params.getBridge();
      if (bridge?.bridge.triggerGreeting) {
        bridge.triggerGreeting(params.greeting);
      } else if (bridge?.bridge.sendUserMessage) {
        bridge.sendUserMessage(params.greeting);
      } else {
        throw new Error("Realtime provider does not support an opening greeting");
      }
    } catch {
      active.failSession("The opening greeting could not start. Restart the call.");
    }
  };
  return {
    noteProviderReady: () => {
      providerReady = true;
      request();
    },
    noteClientAudioAdmitted: () => {
      // An admitted frame proves relay ID adoption and playout initialization.
      // A silent frame is enough; recorded microphone audio is not required.
      clientReady = true;
      request();
    },
  };
}
