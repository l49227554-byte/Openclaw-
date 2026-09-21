import { describe, expect, it } from "vitest";
import { describeConfigSnapshotInputChange } from "./snapshot-inputs.js";
import type { ConfigFileSnapshot } from "./types.js";

const snapshot: ConfigFileSnapshot = {
  path: "/config/openclaw.json",
  exists: true,
  valid: true,
  raw: '{ gateway: { port: "${PORT}" } }',
  parsed: { gateway: { port: "${PORT}" } },
  sourceConfig: { gateway: { port: 18789 } },
  resolved: { gateway: { port: 18789 } },
  runtimeConfig: { gateway: { port: 18789 } },
  config: { gateway: { port: 18789 } },
  hash: "root-and-include-revision",
  issues: [],
  warnings: [],
  legacyIssues: [],
};

describe("config snapshot input identity", () => {
  it.each([
    [{ path: "/config/other.json" }, "config file path changed"],
    [{ exists: false }, "config file was created or removed"],
    [{ raw: "{}", hash: "changed" }, "authored config file contents changed"],
    [{ hash: "changed-include" }, "included config contents or targets changed"],
    [{ sourceConfig: { gateway: { port: 18790 } } }, "resolved config values changed"],
  ] satisfies [Partial<ConfigFileSnapshot>, string][])("detects %j", (change, reason) => {
    expect(describeConfigSnapshotInputChange(snapshot, { ...snapshot, ...change })).toBe(reason);
  });

  it("allows validation and runtime projections to differ for unchanged inputs", () => {
    expect(
      describeConfigSnapshotInputChange(snapshot, {
        ...snapshot,
        valid: false,
        runtimeConfig: {},
        config: {},
      }),
    ).toBeUndefined();
  });
});
