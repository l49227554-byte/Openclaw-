import path from "node:path";
import { createTempHomeEnv, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { assertCodexModelBackedReviewerEffectiveConfig } from "./config-reviewer-policy.js";
import { assertCodexNativeHookRelayAllowed } from "./native-hook-relay.js";
import { resolveCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import { checkCodexThreadAppAvailability } from "./plugin-thread-attestation.js";
import { resolveCodexProviderWebSearchSupportForClient } from "./provider-capabilities.js";
import { createClientHarness } from "./test-support.js";

type Helper = {
  name: string;
  method: string;
  response: (cwd: string) => unknown;
  run: (client: CodexAppServerClient, assertCurrent: () => void, cwd: string) => Promise<unknown>;
};
const helpers: Helper[] = [
  {
    name: "provider capability",
    method: "modelProvider/capabilities/read",
    response: () => ({ webSearch: true }),
    run: (client, assertCurrent) =>
      resolveCodexProviderWebSearchSupportForClient({
        client,
        assertCurrent,
        timeoutMs: 1000,
        modelProviderOverride: undefined,
        signal: new AbortController().signal,
      }),
  },
  {
    name: "skill inventory",
    method: "skills/list",
    response: (cwd) => ({ data: [{ cwd, errors: [], skills: [] }] }),
    run: (client, assertCurrent, cwd) =>
      resolveCodexNativeSkillIsolation({ client, assertCurrent, cwd }),
  },
  {
    name: "hook policy",
    method: "configRequirements/read",
    response: () => ({ requirements: null }),
    run: (client, assertCurrent) =>
      assertCodexNativeHookRelayAllowed(client, undefined, assertCurrent),
  },
  {
    name: "reviewer configuration",
    method: "config/read",
    response: () => ({ config: {} }),
    run: (client, assertCurrent, cwd) =>
      assertCodexModelBackedReviewerEffectiveConfig({
        client,
        assertCurrent,
        cwd,
        approvalsReviewer: "auto_review",
      }),
  },
  {
    name: "thread app inventory",
    method: "app/installed",
    response: () => ({ apps: [{ id: "test-app", enabled: true, callable: true }] }),
    run: (client, assertCurrent) =>
      checkCodexThreadAppAvailability({
        client,
        assertCurrent,
        threadId: "thread-test",
        appIds: ["test-app"],
      }),
  },
];

it.each(helpers)(
  "enforces retained source authority at the $name physical request",
  async (helper) => {
    const home = await createTempHomeEnv("codex-fork-authority-");
    try {
      await withEnvAsync(
        { HOME: home.home, OPENCLAW_STATE_DIR: path.join(home.home, "isolated-state") },
        async () => {
          for (const revoked of [false, true]) {
            const harness = createClientHarness();
            let checks = 0;
            const assertCurrent = () => {
              checks++;
              if (revoked) {
                throw new Error("catalog source revoked");
              }
            };
            try {
              // Attach the rejection handler before a synchronous client rejection.
              const pending = helper.run(harness.client, assertCurrent, home.home).then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
              );
              if (!revoked) {
                const request = JSON.parse(await harness.waitForWrite(0));
                expect(request.method).toBe(helper.method);
                harness.send({ id: request.id, result: helper.response(home.home) });
              }
              const result = await pending;
              expect(checks).toBeGreaterThan(0);
              expect(harness.writes).toHaveLength(revoked ? 0 : 1);
              if (!revoked) {
                expect(result).not.toHaveProperty("error");
              } else if (helper.name === "provider capability") {
                // Its existing failure policy reports unknown; the enclosing fork rechecks authority.
                expect(result).toEqual({ value: "unknown" });
              } else {
                expect(result).toHaveProperty("error");
              }
            } finally {
              harness.client.close();
            }
          }
        },
      );
    } finally {
      await home.restore();
    }
  },
);
