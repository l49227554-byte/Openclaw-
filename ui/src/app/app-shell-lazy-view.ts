import { html, nothing } from "lit";
import type { RouteId } from "../app-routes.ts";
import { renderLazyElementModal } from "../components/lazy-view-error.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import {
  debugOverlayTemplate,
  renderPendingDebugOverlay,
  type DebugOverlayFrameHost,
} from "../pages/debug/debug-overlay-frame.ts";
import {
  renderCommandPaletteLoading,
  type CommandPaletteLoadingState,
} from "./app-shell-command-palette-loading.ts";
import { openShellNewSession, type ShellNewSessionHost } from "./app-shell-new-session.ts";
import type { ApplicationNavigationOptions } from "./context.ts";
import {
  isOptionalElementDefined,
  type LazyCustomElementRequestController,
  type OptionalCustomElement,
  DEBUG_OVERLAY_ELEMENT,
  KEYBOARD_SHORTCUTS_ELEMENT,
} from "./lazy-custom-element.ts";
import { normalizeChatSendShortcut } from "./settings.ts";

export interface ShellLazyOverlayHost extends DebugOverlayFrameHost, ShellNewSessionHost {
  readonly commandPaletteElement: OptionalCustomElement;
  readonly commandPaletteLoading: CommandPaletteLoadingState;
  closePendingPalette(): void;
  readonly lazyCustomElements: LazyCustomElementRequestController;
  handleCommandPaletteSlashCommand(command: string): void;
  navigate(routeId: string, options?: ApplicationNavigationOptions): void;
  selectChatSession(sessionKey: string, agentId?: string | null): void;
}

/** Shell-level optional dialogs share lazy-load recovery, not route ownership. */
export function renderShellLazyOverlays(
  host: ShellLazyOverlayHost,
  desktopPanelAvailable: boolean,
  custodianPanelAvailable: boolean,
  nativeEmbed: boolean,
) {
  const lazyElementState = host.lazyCustomElements.visibleState;
  const context = host.context;
  const uiSettings = context?.theme.settings;
  const onNewSession =
    !host.onboardingMode &&
    readSessionMethodAccess(context?.gateway.snapshot, { method: "sessions.create", params: {} })
      .allowed
      ? () => {
          // Help dismissal is asynchronous; do not carry its intent into another Gateway.
          if (host.isConnected && host.context === context) {
            openShellNewSession(host, "shortcut");
          }
        }
      : undefined;
  return html`
    ${
      host.commandPaletteLoading.active &&
      (!lazyElementState ||
        (lazyElementState.status === "loading" &&
          lazyElementState.element === host.commandPaletteElement))
        ? renderCommandPaletteLoading(host.commandPaletteLoading, () => host.closePendingPalette())
        : lazyElementState?.element === DEBUG_OVERLAY_ELEMENT
          ? renderPendingDebugOverlay(host, lazyElementState)
          : renderLazyElementModal(host.lazyCustomElements)
    }
    ${
      isOptionalElementDefined(host.commandPaletteElement)
        ? html`<openclaw-command-palette
            .desktopAvailable=${desktopPanelAvailable}
            .custodianAvailable=${custodianPanelAvailable}
            .onNavigate=${(routeId: RouteId, options?: ApplicationNavigationOptions) =>
              host.navigate(routeId, options)}
            .onSelectSession=${(sessionKey: string) => host.selectChatSession(sessionKey)}
            .onSlashCommand=${(command: string) => host.handleCommandPaletteSlashCommand(command)}
          ></openclaw-command-palette>`
        : nothing
    }
    ${isOptionalElementDefined(DEBUG_OVERLAY_ELEMENT) ? debugOverlayTemplate : nothing}
    ${
      !nativeEmbed && isOptionalElementDefined(KEYBOARD_SHORTCUTS_ELEMENT)
        ? html`<openclaw-keyboard-shortcuts-dialog
            .sendShortcut=${normalizeChatSendShortcut(uiSettings?.chatSendShortcut)}
            .onNewSession=${onNewSession}
          ></openclaw-keyboard-shortcuts-dialog>`
        : nothing
    }
  `;
}
