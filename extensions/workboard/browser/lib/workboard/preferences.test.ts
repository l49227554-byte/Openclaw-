import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultWorkboardPreferences,
  extractWorkboardPreferences,
  loadWorkboardPreferences,
  saveWorkboardPreferences,
  type WorkboardUiPreferences,
} from "./preferences.ts";

const STORAGE_KEY = "***";

function makeLocalStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe("workboard preferences", () => {
  let storage: Storage;

  beforeEach(() => {
    // Use Object.defineProperty to force-replace localStorage regardless of any
    // getter the host environment (happy-dom / jsdom) may install on globalThis.
    // Keep a direct reference so the test file and the module under test see the
    // exact same Storage instance.
    storage = makeLocalStorage();
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("defaultWorkboardPreferences", () => {
    it("returns the documented defaults", () => {
      expect(defaultWorkboardPreferences()).toEqual({
        viewMode: "board",
        layout: "comfortable",
        emptyColumnMode: "show",
      });
    });

    it("returns a fresh object on every call (no shared mutable default)", () => {
      const first = defaultWorkboardPreferences();
      first.viewMode = "list";
      expect(defaultWorkboardPreferences().viewMode).toBe("board");
    });
  });

  describe("saveWorkboardPreferences", () => {
    it("overwrites any previous value", () => {
      saveWorkboardPreferences({
        viewMode: "list",
        layout: "compact",
        emptyColumnMode: "collapse",
      });
      saveWorkboardPreferences({
        viewMode: "board",
        layout: "comfortable",
        emptyColumnMode: "show",
      });
      expect(loadWorkboardPreferences()).toEqual({
        viewMode: "board",
        layout: "comfortable",
        emptyColumnMode: "show",
      });
    });

    it("silently no-ops when localStorage.setItem throws", () => {
      Object.defineProperty(globalThis, "localStorage", {
        value: {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota exceeded");
          },
        },
        writable: true,
        configurable: true,
      });
      expect(() =>
        saveWorkboardPreferences({
          viewMode: "list",
          layout: "compact",
          emptyColumnMode: "collapse",
        }),
      ).not.toThrow();
    });
  });

  describe("loadWorkboardPreferences", () => {
    it("returns defaults when nothing has been stored", () => {
      expect(loadWorkboardPreferences()).toEqual(defaultWorkboardPreferences());
    });

    it("returns stored preferences on round-trip", () => {
      const prefs: WorkboardUiPreferences = {
        viewMode: "list",
        layout: "compact",
        emptyColumnMode: "hide",
      };
      saveWorkboardPreferences(prefs);
      expect(loadWorkboardPreferences()).toEqual(prefs);
    });

    it("returns defaults when stored JSON is malformed", () => {
      storage.setItem(STORAGE_KEY, "{not valid json");
      expect(loadWorkboardPreferences()).toEqual(defaultWorkboardPreferences());
    });

    it("returns defaults when stored payload is missing required fields", () => {
      storage.setItem(STORAGE_KEY, JSON.stringify({ viewMode: "list" }));
      expect(loadWorkboardPreferences()).toEqual(defaultWorkboardPreferences());
    });

    it("returns defaults when stored fields have invalid values", () => {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          viewMode: "sideways",
          layout: "compact",
          emptyColumnMode: "collapse",
        }),
      );
      expect(loadWorkboardPreferences()).toEqual(defaultWorkboardPreferences());
    });

    it("returns defaults when stored payload is not an object", () => {
      storage.setItem(STORAGE_KEY, JSON.stringify("a string"));
      expect(loadWorkboardPreferences()).toEqual(defaultWorkboardPreferences());
      storage.setItem(STORAGE_KEY, JSON.stringify(null));
      expect(loadWorkboardPreferences()).toEqual(defaultWorkboardPreferences());
    });

    it("returns defaults when localStorage.getItem throws", () => {
      Object.defineProperty(globalThis, "localStorage", {
        value: {
          getItem: () => {
            throw new Error("storage disabled");
          },
          setItem: () => {},
        },
        writable: true,
        configurable: true,
      });
      expect(loadWorkboardPreferences()).toEqual(defaultWorkboardPreferences());
    });
  });

  describe("extractWorkboardPreferences", () => {
    it("extracts the three preference fields from a state object", () => {
      const state = {
        viewMode: "list" as const,
        layout: "compact" as const,
        emptyColumnMode: "collapse" as const,
        // other state fields should be ignored
        query: "should not appear",
        cards: [],
      };
      expect(extractWorkboardPreferences(state)).toEqual({
        viewMode: "list",
        layout: "compact",
        emptyColumnMode: "collapse",
      });
    });
  });
});
