import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  consumeCronCreatorAuthorityGrant,
  mintCronCreatorAuthorityGrant,
  resolveCronCreatorAuthorityGrantProvenance,
  revokeCronCreatorAuthorityRunScope,
} from "../gateway/cron-creator-authority-grant.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import {
  bindActiveCronCreatorAuthorityResolver,
  bindActiveOperatorTurnAuthority,
  bindCronManagementGrant,
  bindCronRequesterGrant,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapabilityResolver,
} from "./cron-creator-authority-context.js";
import { createCronTool } from "./tools/cron-tool.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

describe("fresh remote administrator creation", () => {
  it.each([true, undefined] as const)(
    "separates fresh caller creation (%s) from management and runtime authority",
    async (callerScopedCreation) => {
      const runId = "remote-admin-creation";
      const { operationalRunInstance } = createTestAdmittedRunContext(runId);
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      onTestFinished(() => {
        releaseAgentRunDelegatedAuthority(authority);
      });
      const scope = createCronCreatorAuthorityCapability(
        runId,
        { kind: "unknown" },
        { source: "control-ui-admin" },
        undefined,
        undefined,
        undefined,
        callerScopedCreation,
      )!;
      await runWithCronCreatorAuthorityCapability(scope, () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:remote",
            operationalRunInstance,
            approvalAuthority: authority,
          },
          async () => {
            const management = bindCronManagementGrant(runId)!;
            const requester = bindCronRequesterGrant(runId);
            const resolve = vi.fn();
            expect(management.managementOnly).toBe(!callerScopedCreation);
            expect(bindActiveOperatorTurnAuthority(runId)).toBeUndefined();
            expect(
              runWithCronCreatorAuthorityCapabilityResolver({
                capability: scope,
                runId,
                resolve,
                run: () => bindActiveCronCreatorAuthorityResolver(runId),
              }),
            ).toBeUndefined();
            expect(resolve).not.toHaveBeenCalled();
            expect(() => mintCronCreatorAuthorityGrant(scope)).toThrow(
              "Automation creation is not granted",
            );
            if (!callerScopedCreation) {
              expect(requester).toBeUndefined();
              expect(() => management.mint("cron.add")).toThrow("management-only");
              return;
            }
            expect(management.mint("cron.add")).toBeUndefined();
            const grant = requester!();
            expect(resolveCronCreatorAuthorityGrantProvenance(grant, runId)).toEqual({
              capturesRuntimeAuthority: false,
            });
            expect(consumeCronCreatorAuthorityGrant(grant)).toBeUndefined();
            expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow("no longer active");
            const pending = requester!();
            revokeCronCreatorAuthorityRunScope(scope);
            expect(() => consumeCronCreatorAuthorityGrant(pending)).toThrow("no longer active");
            expect(() => requester!()).toThrow("no longer active");
          },
        ),
      );
    },
  );

  it("exposes add but refuses incomplete capture and retired requester authority", async () => {
    const runId = "remote-admin-capture";
    const { operationalRunInstance } = createTestAdmittedRunContext(runId);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    onTestFinished(() => {
      releaseAgentRunDelegatedAuthority(authority);
    });
    const scope = createCronCreatorAuthorityCapability(
      runId,
      { kind: "unknown" },
      { source: "control-ui-admin" },
      undefined,
      undefined,
      undefined,
      true,
    )!;
    await runWithCronCreatorAuthorityCapability(scope, () =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:remote",
          operationalRunInstance,
          approvalAuthority: authority,
        },
        async () => {
          const callGatewayTool = vi.fn();
          const tool = createCronTool(
            {
              runId,
              agentSessionKey: "agent:main:remote",
              creatorToolAllowlist: ["read"],
              creatorToolAllowlistCaptureRef: {},
            },
            { callGatewayTool },
          );
          expect(tool.parameters).toHaveProperty(
            "properties.action.enum",
            expect.arrayContaining(["add", "list", "update"]),
          );
          await expect(
            tool.execute("incomplete", {
              action: "add",
              job: {
                schedule: { kind: "every", everyMs: 60_000 },
                payload: { kind: "agentTurn", message: "Read status" },
              },
            }),
          ).rejects.toThrow("did not capture the complete model-callable tool surface");
          expect(callGatewayTool).not.toHaveBeenCalled();
          const requester = bindCronRequesterGrant(runId)!;
          const grant = requester();
          releaseAgentRunDelegatedAuthority(authority);
          expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow("no longer active");
          expect(() => requester()).toThrow("no longer active");
        },
      ),
    );
  });
});
