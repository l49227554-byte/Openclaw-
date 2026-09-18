import { describe, expect, it } from "vitest";
import { formatExtraPaths } from "./cli-runtime-common.js";

describe("formatExtraPaths", () => {
  it("prints evergreen policy with and without a glob pattern", () => {
    expect(
      formatExtraPaths("/tmp/openclaw", [
        { path: "reference", evergreen: true },
        { path: "notes", pattern: "runbooks/**/*.md", evergreen: true },
      ]),
    ).toEqual([
      "/tmp/openclaw/reference (evergreen)",
      "/tmp/openclaw/notes (pattern: runbooks/**/*.md, evergreen)",
    ]);
  });
});
