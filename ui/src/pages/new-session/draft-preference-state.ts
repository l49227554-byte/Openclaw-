import type { UsersPrefsSetResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { saveUserPreferences } from "../../app/user-prefs-cache.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import * as catalog from "./catalog-target.ts";
import type { NewSessionRouteData } from "./location.ts";
import {
  decodeIdentityPreferences,
  encodeIdentityPreferences,
  loadBrowserPreferences,
  loadNewSessionPreference,
  patchNewSessionPreference,
  PREFS_MIGRATION_KEY,
  replaceBrowserPreference,
  resolveNewSessionFolderPreference,
  type NewSessionPreference,
} from "./preferences.ts";

registerNewSessionSetupEnglish();

type DraftPreferenceSnapshot = Readonly<{
  source: ApplicationContext["gateway"] | null;
  client: ApplicationContext["gateway"]["snapshot"]["client"];
  gatewayUrl: string;
  recoveryScope: string;
  bootId: string;
  connected: boolean;
  connectionEpoch: number;
  data: NewSessionRouteData | undefined;
  pendingPlacementSessionKey: string;
  agentsHydrated: boolean;
}>;

type PreferenceWriter = { selection: object; write: Promise<void> };
type PreferenceWrites = {
  agents: Map<string, PreferenceWriter>;
  revision: object;
  listeners: Set<(agentId: string, preference: NewSessionPreference) => void>;
};

export class DraftPreferenceState {
  private static readonly preferenceWriters = new WeakMap<
    ApplicationContext["gateway"],
    PreferenceWrites
  >();
  private preferenceScope = "";
  private preferenceModeValue: "local" | "loading" | "remote" = "local";
  private identityPreferences: Record<string, NewSessionPreference> = {};
  private preferenceLoad: Promise<void> = Promise.resolve();
  private stopPreferencePublication: (() => void) | undefined;
  private publicationOwner: readonly unknown[] | undefined;

  constructor(
    private readonly read: () => DraftPreferenceSnapshot,
    private readonly callbacks: { requestUpdate: () => void; onAdoptAgentDefaults: () => void },
  ) {}

  get loading(): boolean {
    return this.preferenceModeValue === "loading";
  }

  synchronize() {
    const { source: gateway, connected, recoveryScope } = this.read();
    if (!gateway) {
      return;
    }
    const snapshot = gateway.snapshot;
    const owner = [gateway, snapshot.client, connected, recoveryScope, snapshot.selfUser?.id];
    if (
      !this.publicationOwner ||
      owner.some((value, index) => value !== this.publicationOwner?.[index])
    ) {
      this.publicationOwner = owner;
      this.stopPreferencePublication?.();
      this.stopPreferencePublication = undefined;
      if (connected) {
        const writes = this.preferenceWrites(gateway);
        const listener = (agentId: string, preference: NewSessionPreference) => {
          if (
            this.read().source !== gateway ||
            this.read().client !== snapshot.client ||
            this.read().recoveryScope !== recoveryScope ||
            gateway.snapshot.hello?.auth?.recoveryScope !== recoveryScope ||
            gateway.snapshot.selfUser?.id !== snapshot.selfUser?.id
          ) {
            return;
          }
          this.identityPreferences = { ...this.identityPreferences, [agentId]: preference };
          if (this.read().agentsHydrated) {
            this.callbacks.onAdoptAgentDefaults();
          }
          this.callbacks.requestUpdate();
        };
        writes.listeners.add(listener);
        this.stopPreferencePublication = () => writes.listeners.delete(listener);
      }
    }

    this.synchronizeIdentityPreferences(snapshot.selfUser?.id);
  }

  disconnect() {
    this.stopPreferencePublication?.();
    this.stopPreferencePublication = undefined;
    this.publicationOwner = undefined;
    this.preferenceScope = "";
  }

  readPreference(agentId: string): NewSessionPreference | null {
    const snapshot = this.read();
    if (
      catalog.isTarget(snapshot.data) ||
      snapshot.data?.group ||
      snapshot.pendingPlacementSessionKey
    ) {
      return null;
    }
    return this.preferenceModeValue === "remote"
      ? (this.identityPreferences[normalizeAgentId(agentId)] ?? null)
      : loadNewSessionPreference(this.read().gatewayUrl, agentId);
  }

  private preferenceWrites(source: ApplicationContext["gateway"]): PreferenceWrites {
    let writes = DraftPreferenceState.preferenceWriters.get(source);
    if (!writes) {
      writes = { agents: new Map(), revision: {}, listeners: new Set() };
      DraftPreferenceState.preferenceWriters.set(source, writes);
    }
    return writes;
  }

  capturePreferenceConsumption(agentId: string, workspace: string, expected: NewSessionPreference) {
    return this.preparePreferenceWrite(agentId, workspace, { worktreeName: "" }, expected);
  }

  persistPreference(agentId: string, workspace: string, patch: NewSessionPreference) {
    return this.preparePreferenceWrite(agentId, workspace, patch)?.();
  }

  private preparePreferenceWrite(
    agentIdValue: string,
    workspace: string,
    patch: NewSessionPreference,
    expected?: NewSessionPreference,
  ): ((consume?: () => void) => void | Promise<void>) | undefined {
    const snapshot = this.read();
    const accepted = expected !== undefined;
    const persist =
      !catalog.isTarget(snapshot.data) &&
      !snapshot.data?.group &&
      (accepted || !snapshot.pendingPlacementSessionKey);
    if (!persist && !accepted) {
      return undefined;
    }
    const source = this.read().source;
    if (!source) {
      return undefined;
    }
    const client = this.read().client;
    const scope = this.preferenceScope;
    const gatewayUrl = this.read().gatewayUrl;
    const recoveryScope = this.read().recoveryScope;
    const bootId = this.read().bootId;
    const profileId = source?.snapshot.selfUser?.id;
    const preferenceLoad = this.preferenceLoad;
    const agentId = normalizeAgentId(agentIdValue);
    const writes = this.preferenceWrites(source);
    let writer = writes.agents.get(agentId);
    if (!writer) {
      writer = { selection: {}, write: Promise.resolve() };
      writes.agents.set(agentId, writer);
    }
    const capturedSelection = writer.selection;
    const ownsConnection = () =>
      Boolean(
        source &&
        client &&
        source.snapshot.client === client &&
        source.snapshot.phase === "connected" &&
        source.connection.gatewayUrl === gatewayUrl &&
        client.recoveryScope === recoveryScope &&
        (source.snapshot.hello?.auth?.recoveryScope ?? "") === recoveryScope &&
        source.snapshot.hello?.server?.bootId === bootId &&
        source.snapshot.selfUser?.id === profileId,
      );
    const nextPatch = accepted ? patch : { workspace, ...patch };
    const matchesSubmitted = (current: NewSessionPreference | null | undefined) =>
      !expected ||
      Boolean(
        current &&
        current.worktreeName === expected.worktreeName &&
        current.worktree === true &&
        (current.workspace ?? workspace) === workspace &&
        resolveNewSessionFolderPreference(current, workspace).folder === expected.folder &&
        (!current.baseRef || current.baseRef === expected.baseRef) &&
        (current.projectId ?? "") === (expected.projectId ?? ""),
      );
    const publish = (preference: NewSessionPreference) => {
      if (!accepted) {
        return;
      }
      writes.revision = {};
      for (const listener of writes.listeners) {
        listener(agentId, preference);
      }
    };
    const writeLocal = () => {
      if (matchesSubmitted(loadNewSessionPreference(gatewayUrl, agentId))) {
        const saved = patchNewSessionPreference(gatewayUrl, agentId, nextPatch);
        if (saved) {
          publish(loadNewSessionPreference(gatewayUrl, agentId) ?? {});
        }
        return saved;
      }
      return undefined;
    };
    return async (consume) => {
      if (accepted && (!ownsConnection() || writer.selection !== capturedSelection)) {
        return;
      }
      // Model controls share persistence, but do not replace the submitted checkout intent.
      const changesPlacement = Object.keys(patch).some(
        (field) => !["model", "agentRuntime", "thinkingLevel"].includes(field),
      );
      const selection = changesPlacement ? {} : writer.selection;
      writer.selection = selection;
      consume?.();
      if (!persist) {
        return;
      }
      const isCurrent = () =>
        accepted
          ? ownsConnection() && writer.selection === selection
          : this.preferenceScope === scope;
      const reportFailure = () => {
        if (accepted && isCurrent()) {
          showToast({ message: t("newSession.worktreeNameClearUnconfirmed") });
        }
      };
      if (this.preferenceModeValue === "local") {
        if (writeLocal() === false) {
          reportFailure();
        }
        return;
      }
      const write = async () => {
        await preferenceLoad;
        if (!client || !isCurrent()) {
          return;
        }
        if (this.preferenceModeValue === "local") {
          if (writeLocal() === false) {
            reportFailure();
          }
          return;
        }
        try {
          if (!profileId) {
            return;
          }
          const { loadUserPreferences } = await import("../../app/user-prefs-request.ts");
          const current = await loadUserPreferences(client, profileId);
          if (!isCurrent()) {
            return;
          }
          if (current.status !== "ok") {
            reportFailure();
            return;
          }
          const preferences = decodeIdentityPreferences(current.entries);
          if (!matchesSubmitted(preferences[agentId])) {
            return;
          }
          const next = { ...preferences[agentId], ...nextPatch };
          const result = await saveUserPreferences(client, {
            entries: encodeIdentityPreferences({ [agentId]: next }),
          });
          // A queued edit can supersede admission, but not a clear already committed by this owner.
          if (accepted ? !ownsConnection() : !isCurrent()) {
            return;
          }
          if (result.status !== "ok") {
            reportFailure();
            return;
          }
          replaceBrowserPreference(gatewayUrl, agentId, next);
          publish(next);
          if (this.preferenceScope === scope) {
            this.identityPreferences = { ...this.identityPreferences, [agentId]: next };
            this.callbacks.requestUpdate();
          }
        } catch {
          // Retain the last confirmed value without reversing an accepted session.
          reportFailure();
        }
      };
      // Route disposal must not let a newer draft race a dispatched preference write.
      writer.write = writer.write.then(write, write);
      return writer.write;
    };
  }

  private synchronizeIdentityPreferences(profileId: string | undefined) {
    const client = this.read().connected ? this.read().client : null;
    const source = this.read().source;
    const advertised =
      source &&
      isGatewayMethodAdvertised(source.snapshot, "users.prefs.get") === true &&
      isGatewayMethodAdvertised(source.snapshot, "users.prefs.set") === true;
    const scope =
      client && profileId && advertised ? `${this.read().connectionEpoch}\0${profileId}` : "local";
    if (scope === this.preferenceScope) {
      return;
    }
    this.preferenceScope = scope;
    this.identityPreferences = {};
    if (!client || !profileId || !advertised) {
      this.preferenceModeValue = "local";
      this.preferenceLoad = Promise.resolve();
      return;
    }
    this.preferenceModeValue = "loading";
    this.preferenceLoad = this.loadIdentityPreferences({
      client,
      gatewayUrl: this.read().gatewayUrl,
      scope,
      profileId,
    });
  }

  private async loadIdentityPreferences(params: {
    client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
    gatewayUrl: string;
    scope: string;
    profileId: string;
  }): Promise<void> {
    const source = this.read().source;
    const writes = source ? this.preferenceWrites(source) : undefined;
    const revision = writes?.revision;
    try {
      const { loadUserPreferences } = await import("../../app/user-prefs-request.ts");
      if (this.preferenceScope !== params.scope) {
        return;
      }
      const result = await loadUserPreferences(params.client, params.profileId);
      if (this.preferenceScope !== params.scope) {
        return;
      }
      if (result.status !== "ok") {
        this.preferenceModeValue = "local";
        return;
      }
      if (writes?.revision !== revision) {
        return this.loadIdentityPreferences(params);
      }
      let preferences = decodeIdentityPreferences(result.entries);
      const browserPreferences = loadBrowserPreferences(params.gatewayUrl);
      if (result.entries[PREFS_MIGRATION_KEY] !== true) {
        const missingBrowserPreferences = Object.fromEntries(
          Object.entries(browserPreferences).filter(
            ([agentId]) => !Object.hasOwn(preferences, agentId),
          ),
        );
        const migrationEntries = [
          ...Object.entries(encodeIdentityPreferences(missingBrowserPreferences)),
          [PREFS_MIGRATION_KEY, true] as const,
        ];
        let migrationFailed = false;
        for (let offset = 0; offset < migrationEntries.length; offset += 32) {
          const batch = Object.fromEntries(migrationEntries.slice(offset, offset + 32));
          let response: UsersPrefsSetResult;
          try {
            response = await saveUserPreferences(params.client, {
              entries: batch,
            });
          } catch {
            migrationFailed = true;
            break;
          }
          if (this.preferenceScope !== params.scope) {
            return;
          }
          if (response.status !== "ok") {
            migrationFailed = true;
            break;
          }
          Object.assign(preferences, decodeIdentityPreferences(batch));
        }
        if (migrationFailed) {
          preferences = { ...browserPreferences, ...preferences };
        }
      }
      if (writes?.revision !== revision) {
        return this.loadIdentityPreferences(params);
      }
      this.identityPreferences = preferences;
      this.preferenceModeValue = "remote";
      for (const [agentId, preference] of Object.entries(preferences)) {
        replaceBrowserPreference(params.gatewayUrl, agentId, preference);
      }
      if (this.read().agentsHydrated) {
        this.callbacks.onAdoptAgentDefaults();
      }
      this.callbacks.requestUpdate();
    } catch {
      if (this.preferenceScope === params.scope) {
        this.preferenceModeValue = "local";
        this.callbacks.requestUpdate();
      }
    }
  }
}
