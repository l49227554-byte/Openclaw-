import { describe, expect, it } from "vitest";
import { resolveDynamicsProfile } from "./dynamics-profiles.js";

describe("profile catalog ownership", () => {
  it.each(["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"])(
    "rejects inherited name %s",
    (id) => {
      expect(() => resolveDynamicsProfile(id)).toThrow("Unknown cognitive dynamics profile");
    },
  );
});
