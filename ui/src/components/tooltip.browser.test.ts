import { afterEach, describe, expect, it } from "vitest";
import { duringElementAnimation } from "../test-helpers/web-awesome-animation.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "./tooltip.ts";

afterEach(() => document.body.replaceChildren());

function recordLifecycle(tooltip: HTMLElement) {
  const events: string[] = [];
  for (const type of ["wa-show", "wa-hide", "wa-after-show", "wa-after-hide"]) {
    tooltip.addEventListener(type, (event) => {
      if (event.target === tooltip) {
        events.push(type);
      }
    });
  }
  return events;
}

function afterTransition(tooltip: HTMLElement, operation: "show" | "hide") {
  return new Promise<void>((resolve) => {
    tooltip.addEventListener(`wa-after-${operation}`, () => resolve(), { once: true });
  });
}

describe.runIf("__vitest_browser__" in globalThis)("tooltip pointer ownership", () => {
  async function openTooltip(rich: boolean) {
    const tooltip = document.createElement("openclaw-tooltip");
    const trigger = document.createElement("button");
    trigger.textContent = "Details";
    trigger.style.cssText = "position: fixed; left: 200px; top: 200px";
    tooltip.append(trigger);
    let link: HTMLAnchorElement | undefined;
    if (rich) {
      link = document.createElement("a");
      link.slot = "content";
      link.href = "#details";
      link.textContent = "Read documentation";
      tooltip.append(link);
    } else {
      tooltip.content = "More information about this action";
    }
    document.body.append(tooltip);
    await tooltip.updateComplete;
    const popup = tooltip.shadowRoot!.querySelector("wa-tooltip")!;
    const shown = new Promise<Event>((resolve) => {
      popup.addEventListener("wa-after-show", resolve, { once: true });
    });
    trigger.focus();
    await shown;
    const body = popup.shadowRoot!.querySelector<HTMLElement>('[part="body"]')!;
    await expect.poll(() => body.getBoundingClientRect().width).toBeGreaterThan(0);
    return { tooltip, trigger, popup, body, link };
  }

  it.each(["body", "bridge"] as const)(
    "lets a real pointer reach an action under a plain tooltip %s",
    async (surface) => {
      const { page } = await import("vitest/browser");
      const { body, trigger } = await openTooltip(false);
      const popupBounds = body.getBoundingClientRect();
      const triggerBounds = trigger.getBoundingClientRect();
      const bounds =
        surface === "body"
          ? popupBounds
          : {
              left: triggerBounds.left,
              top: popupBounds.bottom,
              width: triggerBounds.width,
              height: triggerBounds.top - popupBounds.bottom,
            };
      expect(bounds.height).toBeGreaterThan(0);
      const action = document.createElement("button");
      action.textContent = "Tool access";
      action.style.cssText = `position: fixed; left: ${bounds.left}px; top: ${bounds.top}px; width: ${bounds.width}px; height: ${bounds.height}px`;
      document.body.append(action);
      let activated = false;
      action.addEventListener("click", () => {
        activated = true;
      });
      expect(
        document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2),
      ).toBe(action);
      await page.elementLocator(action).click();
      expect(activated).toBe(true);
    },
  );

  it("keeps rich tooltip links pointer-accessible", async () => {
    const { page } = await import("vitest/browser");
    const { link } = await openTooltip(true);
    let activated = false;
    link!.addEventListener("click", (event) => {
      event.preventDefault();
      activated = true;
    });
    await page.elementLocator(link!).click();
    expect(activated).toBe(true);
  });
});

describe.runIf("__vitest_browser__" in globalThis)("tooltip transition ownership", () => {
  async function fixture(zeroDuration = false) {
    const tooltip = document.createElement("openclaw-tooltip");
    tooltip.content = "More information about this action";
    const trigger = document.createElement("button");
    trigger.textContent = "Details";
    trigger.style.cssText = "position: fixed; left: 200px; top: 200px";
    tooltip.append(trigger);
    document.body.append(tooltip);
    await tooltip.updateComplete;
    const native = tooltip.shadowRoot!.querySelector("wa-tooltip")!;
    await native.updateComplete;
    await native.popup.updateComplete;
    if (zeroDuration) {
      // WaPopup owns these properties on its host; set the actual animation
      // owner rather than assuming the wrapper's custom properties inherit.
      native.popup.style.setProperty("--show-duration", "0ms");
      native.popup.style.setProperty("--hide-duration", "0ms");
    }
    return { tooltip, trigger, native, events: recordLifecycle(native) };
  }

  it.each([false, true])(
    "keeps a keyboard-reopened tooltip visible after an interrupted hide (zero duration=%s)",
    async (zeroDuration) => {
      const { tooltip, trigger, native, events } = await fixture(zeroDuration);
      const shown = afterTransition(native, "show");
      trigger.focus();
      await native.updateComplete;
      const duration = Number.parseFloat(getComputedStyle(native.popup.popup).animationDuration);
      if (zeroDuration) {
        expect(duration).toBe(0);
      } else {
        expect(duration).toBeGreaterThan(0);
      }
      await shown;
      await expect.element(native.body).toBeVisible();
      events.length = 0;

      trigger.blur();
      // Join the reactive close, not its animation. Native focus then admits
      // the next opening before even a zero-duration hide's frame boundary.
      await native.updateComplete;
      expect(events).toEqual(["wa-hide"]);
      const reopened = afterTransition(native, "show");
      trigger.focus();
      await reopened;
      await native.popup.updateComplete;

      expect(document.activeElement).toBe(trigger);
      expect(tooltip.hasAttribute("open")).toBe(true);
      expect(native.open).toBe(true);
      expect(native.body.hidden).toBe(false);
      expect(native.popup.active).toBe(true);
      await expect.element(native.body).toBeVisible();
      expect(events).toEqual(["wa-hide", "wa-show", "wa-after-show"]);
    },
  );

  it("keeps a tooltip dismissed when Escape interrupts its opening animation", async () => {
    const { userEvent } = await import("vitest/browser");
    const { tooltip, trigger, native, events } = await fixture();
    const hidden = afterTransition(native, "hide");
    await duringElementAnimation(
      native.popup.popup,
      "show-with-scale",
      () => trigger.focus(),
      async () => {
        await userEvent.keyboard("{Escape}");
        await native.updateComplete;
      },
    );
    await hidden;
    await native.popup.updateComplete;

    expect(document.activeElement).toBe(trigger);
    expect(tooltip.hasAttribute("open")).toBe(false);
    expect(native.open).toBe(false);
    expect(native.body.hidden).toBe(true);
    expect(native.popup.active).toBe(false);
    await expect.element(native.body).not.toBeVisible();
    expect(events).toEqual(["wa-show", "wa-hide", "wa-after-hide"]);
  });
});

describe.runIf("__vitest_browser__" in globalThis)("Web Awesome tooltip public lifecycle", () => {
  async function fixture(initial?: { open: boolean; disabled: boolean }) {
    const host = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.id = "tooltip-lifecycle-trigger";
    trigger.textContent = "Details";
    trigger.style.cssText = "position: fixed; left: 200px; top: 200px";
    const tooltip = document.createElement("wa-tooltip");
    tooltip.for = trigger.id;
    tooltip.trigger = "manual";
    tooltip.open = initial?.open ?? false;
    tooltip.disabled = initial?.disabled ?? false;
    tooltip.textContent = "More information about this action";
    host.append(trigger, tooltip);
    document.body.append(host);
    await tooltip.updateComplete;
    await tooltip.popup.updateComplete;
    return { host, trigger, tooltip, events: recordLifecycle(tooltip) };
  }

  async function expectVisibility(tooltip: HTMLElementTagNameMap["wa-tooltip"], open: boolean) {
    await tooltip.popup.updateComplete;
    expect(tooltip.open).toBe(open);
    expect(tooltip.popup.active).toBe(open);
    expect(tooltip.body.hidden).toBe(!open);
    if (open) {
      await expect.element(tooltip.body).toBeVisible();
    } else {
      await expect.element(tooltip.body).not.toBeVisible();
    }
  }

  it.each([false, true])("honors initial open intent when disabled=%s", async (disabled) => {
    const { tooltip } = await fixture({ open: true, disabled });
    if (!disabled) {
      await tooltip.show();
    }
    await expectVisibility(tooltip, !disabled);
  });

  it.each(["show", "hide"] as const)(
    "settles a public %s interrupted before its animation sample without stale completion",
    async (operation) => {
      const { tooltip, events } = await fixture();
      if (operation === "hide") {
        await tooltip.show();
        events.length = 0;
      }
      const opposite = operation === "show" ? "hide" : "show";
      const pending = tooltip[operation]();
      await tooltip.updateComplete;
      expect(events).toEqual([`wa-${operation}`]);
      const replacement = tooltip[opposite]();
      await Promise.all([pending, replacement]);

      await expectVisibility(tooltip, opposite === "show");
      expect(events).toEqual([`wa-${operation}`, `wa-${opposite}`, `wa-after-${opposite}`]);
    },
  );

  it.each(["show", "hide"] as const)(
    "settles a vetoed public %s and accepts the next request",
    async (operation) => {
      const { tooltip, events } = await fixture();
      if (operation === "hide") {
        await tooltip.show();
        events.length = 0;
      }
      tooltip.addEventListener(`wa-${operation}`, (event) => event.preventDefault(), {
        once: true,
      });
      let settled = false;
      const vetoed = tooltip[operation]().then(() => {
        settled = true;
      });
      await expect.poll(() => settled).toBe(true);
      await vetoed;
      await expectVisibility(tooltip, operation === "hide");
      expect(events).toEqual([`wa-${operation}`]);

      await tooltip[operation]();
      await expectVisibility(tooltip, operation === "show");
      expect(events).toEqual([`wa-${operation}`, `wa-${operation}`, `wa-after-${operation}`]);
    },
  );

  it.each(["show", "hide"] as const)(
    "retires a public %s on disconnect before a fresh keyboard reveal",
    async (operation) => {
      const { userEvent } = await import("vitest/browser");
      const { host, trigger, tooltip, events } = await fixture();
      if (operation === "hide") {
        await tooltip.show();
        events.length = 0;
      }
      const pending = tooltip[operation]();
      await tooltip.updateComplete;
      expect(events).toEqual([`wa-${operation}`]);
      host.remove();
      expect(tooltip.popup.active).toBe(false);
      expect(tooltip.body.hidden).toBe(true);
      expect(events).toEqual([`wa-${operation}`]);

      // Reconnect before the retired promise settles. Explicit closed intent
      // and the next focus must survive the previous connection's cleanup.
      tooltip.open = false;
      tooltip.trigger = "focus";
      document.body.append(host);
      await tooltip.updateComplete;
      expect(tooltip.open).toBe(false);
      expect(tooltip.popup.active).toBe(false);
      expect(tooltip.body.hidden).toBe(true);
      const shown = afterTransition(tooltip, "show");
      trigger.focus();
      await Promise.all([pending, shown]);
      await expectVisibility(tooltip, true);
      const hidden = afterTransition(tooltip, "hide");
      await userEvent.keyboard("{Escape}");
      await hidden;
      await expectVisibility(tooltip, false);
      expect(document.activeElement).toBe(trigger);
      expect(events).toEqual([
        `wa-${operation}`,
        "wa-show",
        "wa-after-show",
        "wa-hide",
        "wa-after-hide",
      ]);
    },
  );
});
