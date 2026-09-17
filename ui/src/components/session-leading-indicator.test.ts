/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { renderSessionLeadingState } from "./session-leading-indicator.ts";

function channelSession(overrides: Partial<SidebarRecentSession> = {}): SidebarRecentSession {
  return {
    key: "agent:main:slack:channel:C1:thread:171234.001",
    label: "Release rollout planning",
    renameValue: "Release rollout planning",
    active: false,
    visuallyActive: false,
    hasActiveRun: false,
    modelSelectionLocked: false,
    pinned: false,
    pinnable: true,
    hasAutomation: false,
    unread: false,
    attention: { kind: "none" },
    childSessionKeys: [],
    children: [],
    isChild: false,
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: 0,
    failedChildCount: 0,
    cloudWorkerStopAction: null,
    channel: "slack",
    channelSession: true,
    ...overrides,
  };
}

afterEach(() => document.body.replaceChildren());

describe("renderSessionLeadingState channel source", () => {
  it("renders a compact Slack channel mark for an otherwise unadorned channel session", () => {
    const container = document.createElement("div");
    render(
      renderSessionLeadingState(channelSession(), undefined, "created").leadingIndicator,
      container,
    );

    expect(container.querySelector(".channels-tile")?.textContent?.trim()).toBe("SL");
    expect(container.querySelector(".sr-only")?.textContent?.trim()).toBe("slack");
    expect(
      container
        .querySelector<HTMLElement>(".channels-tile")
        ?.style.getPropertyValue("--channels-art-size"),
    ).toBe("18px");
  });

  it("keeps a custom session icon ahead of the source channel", () => {
    const container = document.createElement("div");
    render(
      renderSessionLeadingState(channelSession({ icon: "🚀" }), undefined, "created")
        .leadingIndicator,
      container,
    );

    expect(container.textContent).toContain("🚀");
    expect(container.querySelector(".channels-tile")).toBeNull();
  });

  it("keeps descendant run state on the source mark without an unread badge", () => {
    const container = document.createElement("div");
    render(
      renderSessionLeadingState(
        channelSession({ runningChildCount: 1, unread: true }),
        undefined,
        "created",
      ).leadingIndicator,
      container,
    );

    expect(container.querySelector(".channels-tile")).not.toBeNull();
    expect(container.querySelector(".session-glyph--running")).not.toBeNull();
    expect(container.querySelector(".session-glyph__badge--unread")).toBeNull();
  });

  it("does not render the source mark in a team-row trailing slot", () => {
    const container = document.createElement("div");
    render(
      renderSessionLeadingState(channelSession(), undefined, "created", undefined, undefined, true)
        .leadingIndicator,
      container,
    );

    expect(container.querySelector(".channels-tile")).toBeNull();
  });
});
