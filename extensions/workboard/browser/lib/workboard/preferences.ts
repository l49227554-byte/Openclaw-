/**
 * Persisted UI preferences for the Workboard plugin.
 *
 * Scoped to the small set of choices a user would reasonably expect to
 * survive leaving the page and coming back: layout (board vs list),
 * density (comfortable vs compact), and how empty columns are handled.
 *
 * Storage is deliberately client-side via localStorage. Cross-device sync
 * would mean swapping this module for a server-backed preference store;
 * nothing else in the plugin needs to know where the values live.
 */

export type WorkboardViewMode = "board" | "list";
export type WorkboardLayoutDensity = "comfortable" | "compact";
export type WorkboardEmptyColumnMode = "show" | "collapse" | "hide";

export interface WorkboardUiPreferences {
  viewMode: WorkboardViewMode;
  layout: WorkboardLayoutDensity;
  emptyColumnMode: WorkboardEmptyColumnMode;
}

const STORAGE_KEY = "openclaw:workboard:prefs:v1";

const DEFAULT_PREFERENCES: WorkboardUiPreferences = {
  viewMode: "board",
  layout: "comfortable",
  emptyColumnMode: "show",
};

export function defaultWorkboardPreferences(): WorkboardUiPreferences {
  return { ...DEFAULT_PREFERENCES };
}

function isWorkboardUiPreferences(value: unknown): value is WorkboardUiPreferences {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.viewMode === "board" || v.viewMode === "list") &&
    (v.layout === "comfortable" || v.layout === "compact") &&
    (v.emptyColumnMode === "show" ||
      v.emptyColumnMode === "collapse" ||
      v.emptyColumnMode === "hide")
  );
}

export function loadWorkboardPreferences(): WorkboardUiPreferences {
  if (typeof globalThis.localStorage === "undefined") {
    return defaultWorkboardPreferences();
  }
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultWorkboardPreferences();
    const parsed: unknown = JSON.parse(raw);
    if (!isWorkboardUiPreferences(parsed)) return defaultWorkboardPreferences();
    return {
      viewMode: parsed.viewMode,
      layout: parsed.layout,
      emptyColumnMode: parsed.emptyColumnMode,
    };
  } catch {
    return defaultWorkboardPreferences();
  }
}

export function saveWorkboardPreferences(prefs: WorkboardUiPreferences): void {
  if (typeof globalThis.localStorage === "undefined") return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be unavailable (private mode, quota exceeded, etc.).
    // The in-memory state stays authoritative for the session.
  }
}

export function extractWorkboardPreferences(state: {
  viewMode: WorkboardViewMode;
  layout: WorkboardLayoutDensity;
  emptyColumnMode: WorkboardEmptyColumnMode;
}): WorkboardUiPreferences {
  return {
    viewMode: state.viewMode,
    layout: state.layout,
    emptyColumnMode: state.emptyColumnMode,
  };
}
