import { afterEach, describe, expect, it, vi } from "vitest";
import { arxiUserCopy } from "./arxi-user-copy.js";

afterEach(() => vi.unstubAllEnvs());

describe("hosted conversation copy scope", () => {
  it.each(["owner", "group", "enji", "", "other"])(
    "selects only the two product targets: %s",
    (target) => {
      vi.stubEnv("ARXI_CHANNEL_TARGET", target);
      expect(arxiUserCopy("upstream", "product")).toBe(
        target === "owner" || target === "group" ? "product" : "upstream",
      );
    },
  );
});
