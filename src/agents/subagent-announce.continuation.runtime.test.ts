/**
 * Scenario: continuation runtime packaging + announce-host boundary.
 *
 * Covers:
 * - tsdown main-graph entry for `subagent-announce.continuation.runtime`
 * - real coordinator/return-router exports (not a facade)
 * - announce host stays a thin lazy-loader into the coordinator
 *
 * Stubs: none. This is source/export inspection only. After the
 * `src/agents/*` → `src/agents/subagents/announce/*` move, the host lives at
 * `subagents/announce/subagent-announce.ts` and calls the coordinator through
 * `loadSubagentContinuationRuntime`. The lazy import itself lives on
 * `subagent-announce-deps.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as continuationRuntime from "./subagent-announce.continuation.runtime.js";

const TSDOWN_CONFIG_PATH = "tsdown.config.ts";
const ANNOUNCE_HOST_PATH = "src/agents/subagents/announce/subagent-announce.ts";
const ANNOUNCE_LAZY_LOADER_PATH = "src/agents/subagents/announce/subagent-announce-deps.ts";
const CONTINUATION_RUNTIME_PATH = "src/agents/subagent-announce.continuation.runtime.ts";
const CONTINUATION_RUNTIME_LAZY_IMPORT =
  'import("../../subagent-announce.continuation.runtime.js")';

describe("subagent-announce continuation runtime entry", () => {
  it("registers the continuation runtime as a tsdown bundler entry", () => {
    const source = readFileSync(resolve(process.cwd(), TSDOWN_CONFIG_PATH), "utf8");
    expect(source).toMatch(
      /"subagent-announce\.continuation\.runtime":\s*"src\/agents\/subagent-announce\.continuation\.runtime\.ts"/u,
    );
  });

  it("exports the real continuation coordinator and return router", () => {
    expect(typeof continuationRuntime.coordinateSubagentContinuation).toBe("function");
    expect(typeof continuationRuntime.routeSubagentContinuationReturn).toBe("function");
  });

  it("keeps the upstream announce host bounded to coordinator calls", () => {
    const loader = readFileSync(resolve(process.cwd(), ANNOUNCE_LAZY_LOADER_PATH), "utf8");
    const source = readFileSync(resolve(process.cwd(), ANNOUNCE_HOST_PATH), "utf8");
    expect(loader).toContain(CONTINUATION_RUNTIME_LAZY_IMPORT);
    expect(source).toContain("coordinateSubagentContinuation");
    expect(source).toContain("routeSubagentContinuationReturn");
    expect(source).not.toContain("../auto-reply/continuation/delegate-dispatch.js");
    expect(source).not.toContain("function drainChildContinuationQueue");
  });

  it("is not a re-export facade", () => {
    const source = readFileSync(resolve(process.cwd(), CONTINUATION_RUNTIME_PATH), "utf8");
    expect(source).toContain("export async function coordinateSubagentContinuation");
    expect(source).toContain("./subagent-announce.continuation.accounting.js");
    expect(source).toContain("./subagent-announce.continuation-return.js");
  });
});
