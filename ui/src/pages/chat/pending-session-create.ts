import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { renderNewSessionBody } from "../new-session/draft-composer.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChatImageLightbox } from "./components/chat-image-lightbox.ts";

/** Pending admission exposes display bytes, never session mutation controls. */
export function renderPendingSessionCreate(context: ApplicationContext, state: ChatPageHost) {
  const identity = context.gateway.snapshot.selfUser?.identity;
  const pending = context.chatSubmissions.readCreate(
    state.sessionKey,
    state.client,
    context.gateway.snapshot.hello?.auth?.recoveryScope,
  );
  return html`<section class="chat" aria-busy="true">
      ${renderNewSessionBody({
        error: null,
        pendingMessage: pending?.message ?? null,
        userId: identity?.type === "profile" ? identity.id : null,
        submitting: true,
        renderDraft: () => html`<div role="status">${t("newSession.starting")}</div>`,
        onOpenImage: state.handleOpenImage,
      })}
    </section>
    ${renderChatImageLightbox(state.imageLightbox, state.handleCloseImage)}`;
}
