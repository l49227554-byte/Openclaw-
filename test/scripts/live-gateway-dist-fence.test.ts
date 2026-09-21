import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  gatewayServiceCommandOverlapsPhysicalCheckout,
  isLiveManagedGatewayHoldingDist,
  resolveLiveManagedGatewayDistFence,
} from "../../scripts/lib/live-gateway-dist-fence.mts";
import type { GatewayServiceState } from "../../src/daemon/service-types.ts";
import { withTestDir } from "../../src/test-helpers/temp-dir.js";

function baseState(overrides: Partial<GatewayServiceState> = {}): GatewayServiceState {
  return {
    installed: true,
    loadState: { status: "loaded" },
    running: false,
    env: {},
    command: {
      programArguments: [
        "/usr/bin/node",
        "/srv/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
    },
    ...overrides,
  };
}

describe("live-gateway-dist-fence", () => {
  it("allows builds when OPENCLAW_ALLOW_LIVE_DIST_BUILD=1 even if the gateway is live", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      env: { OPENCLAW_ALLOW_LIVE_DIST_BUILD: "1" },
      readState: async () => baseState({ running: true }),
      matchesRoot: async () => true,
    });
    expect(result).toEqual({ refuse: false });
  });

  it("allows builds when the managed Gateway does not use this checkout", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () => baseState({ running: true }),
      matchesRoot: async () => false,
    });
    expect(result).toEqual({ refuse: false });
  });

  it("allows builds when this checkout matches but the Gateway is stopped", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () =>
        baseState({
          running: false,
          runtime: { status: "stopped", pid: undefined },
        }),
      matchesRoot: async () => true,
      isPidAlive: () => false,
    });
    expect(result).toEqual({ refuse: false });
  });

  it("refuses when this checkout matches and the Gateway is running", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () =>
        baseState({
          running: true,
          runtime: {
            status: "running",
            pid: 4242,
            systemd: { unit: "openclaw-gateway.service" },
          },
        }),
      matchesRoot: async () => true,
    });
    expect(result.refuse).toBe(true);
    if (result.refuse) {
      expect(result.message).toContain("Refusing to rebuild dist");
      expect(result.message).toContain("/srv/openclaw/dist/index.js");
      expect(result.message).toContain("openclaw-gateway.service");
      expect(result.message).toContain("openclaw update");
      expect(result.message).toContain("OPENCLAW_ALLOW_LIVE_DIST_BUILD=1");
    }
  });

  it("refuses while a matching Gateway PID is still alive during deactivating drain", async () => {
    expect(
      isLiveManagedGatewayHoldingDist(
        baseState({
          running: false,
          runtime: { status: "deactivating", subState: "stop-sigterm", pid: 99 },
        }),
        { isPidAlive: (pid) => pid === 99 },
      ),
    ).toBe(true);

    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () =>
        baseState({
          running: false,
          runtime: { status: "deactivating", subState: "stop-sigterm", pid: 99 },
        }),
      matchesRoot: async () => true,
      isPidAlive: (pid) => pid === 99,
    });
    expect(result.refuse).toBe(true);
  });

  it("fails open when service inspection throws", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () => {
        throw new Error("no systemd");
      },
    });
    expect(result).toEqual({ refuse: false });
  });

  it("fails open when root matching throws after a successful state read", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () => baseState({ running: true }),
      matchesRoot: async () => {
        throw new Error("realpath failed");
      },
    });
    expect(result).toEqual({ refuse: false });
  });
});

async function writeOpenClawPackage(packageRoot: string) {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"openclaw"}\n');
  await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "gateway\n");
}

describe("live-gateway-dist-fence physical overlap", () => {
  it("refuses when the serving entrypoint is this checkout's dist", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-physical-" }, async (tmp) => {
      await writeOpenClawPackage(tmp);
      const result = await resolveLiveManagedGatewayDistFence(tmp, {
        readState: async () =>
          baseState({
            running: true,
            command: {
              programArguments: [process.execPath, path.join(tmp, "dist", "index.js"), "gateway"],
            },
          }),
      });
      expect(result.refuse).toBe(true);
    });
  });

  it("allows a logically owned current/releases tree whose dist is physically separate", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-release-" }, async (tmp) => {
      const managedRoot = path.join(tmp, "openclaw");
      const release = path.join(tmp, "releases", "selected");
      const current = path.join(tmp, "current");
      await writeOpenClawPackage(managedRoot);
      await writeOpenClawPackage(release);
      await fs.symlink(release, current);
      const command = {
        programArguments: [process.execPath, path.join(current, "dist", "index.js"), "gateway"],
        managedDefinition: {
          programArguments: [
            process.execPath,
            path.join(managedRoot, "dist", "index.js"),
            "gateway",
          ],
        },
      };
      await expect(
        gatewayServiceCommandOverlapsPhysicalCheckout(managedRoot, command),
      ).resolves.toBe(false);
      const result = await resolveLiveManagedGatewayDistFence(managedRoot, {
        readState: async () => baseState({ running: true, command }),
      });
      expect(result).toEqual({ refuse: false });
    });
  });

  it("refuses when the checkout is the physical release behind current", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-release-self-" }, async (tmp) => {
      const release = path.join(tmp, "releases", "selected");
      const current = path.join(tmp, "current");
      await writeOpenClawPackage(release);
      await fs.symlink(release, current);
      const result = await resolveLiveManagedGatewayDistFence(release, {
        readState: async () =>
          baseState({
            running: true,
            command: {
              programArguments: [
                process.execPath,
                path.join(current, "dist", "index.js"),
                "gateway",
              ],
            },
          }),
      });
      expect(result.refuse).toBe(true);
    });
  });
});

describe("live-gateway-dist-fence cross-profile overlap", () => {
  it("refuses when another profile's live Gateway overlaps this checkout", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-cross-profile-" }, async (tmp) => {
      const otherCheckout = path.join(tmp, "other");
      await writeOpenClawPackage(tmp);
      await writeOpenClawPackage(otherCheckout);
      const defaultBinding = {
        profile: "default",
        env: { OPENCLAW_PROFILE: undefined },
      };
      const fenceproofBinding = {
        profile: "fenceproof",
        env: {
          OPENCLAW_PROFILE: "fenceproof",
          OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-fenceproof.service",
        },
      };
      const result = await resolveLiveManagedGatewayDistFence(tmp, {
        env: {},
        listBindings: async () => [defaultBinding, fenceproofBinding],
        readState: async (binding) => {
          if (binding?.profile === "fenceproof") {
            return baseState({
              running: true,
              command: {
                programArguments: [process.execPath, path.join(tmp, "dist", "index.js"), "gateway"],
              },
              runtime: {
                status: "running",
                pid: 4242,
                systemd: { unit: "openclaw-gateway-fenceproof.service" },
              },
            });
          }
          return baseState({
            running: false,
            command: {
              programArguments: [
                process.execPath,
                path.join(otherCheckout, "dist", "index.js"),
                "gateway",
              ],
            },
            runtime: { status: "stopped", pid: undefined },
          });
        },
      });
      expect(result.refuse).toBe(true);
      if (result.refuse) {
        expect(result.message).toContain("fenceproof");
        expect(result.message).toContain("openclaw update");
        expect(result.message).toContain("openclaw gateway stop --profile fenceproof");
        expect(result.message).not.toContain("profiles default, fenceproof");
      }
    });
  });

  it.skipIf(process.platform !== "linux")(
    "refuses through discovered systemd unit fixtures for a sibling profile",
    async () => {
      await withTestDir({ prefix: "openclaw-live-dist-unit-fixture-" }, async (tmp) => {
        const home = path.join(tmp, "home");
        const checkout = path.join(tmp, "checkout");
        const other = path.join(tmp, "other");
        const systemdDir = path.join(home, ".config", "systemd", "user");
        await writeOpenClawPackage(checkout);
        await writeOpenClawPackage(other);
        await fs.mkdir(systemdDir, { recursive: true });
        const unitBody = [
          "[Service]",
          "ExecStart=/usr/bin/node /srv/openclaw/dist/index.js gateway",
          "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
          "Environment=OPENCLAW_SERVICE_KIND=gateway",
          "",
        ].join("\n");
        await fs.writeFile(path.join(systemdDir, "openclaw-gateway.service"), unitBody);
        await fs.writeFile(
          path.join(systemdDir, "openclaw-gateway-fenceproof.service"),
          `${unitBody}Environment=OPENCLAW_PROFILE=fenceproof\n`,
        );

        const { discoverManagedGatewayBindings } =
          await import("../../src/daemon/managed-gateway-bindings.ts");
        const bindings = await discoverManagedGatewayBindings(
          { HOME: home },
          { systemUnitDirs: [] },
        );
        expect(bindings.map((binding) => binding.profile).toSorted()).toEqual([
          "default",
          "fenceproof",
        ]);
        expect(bindings.every((binding) => binding.scope === "user")).toBe(true);

        const result = await resolveLiveManagedGatewayDistFence(checkout, {
          env: { HOME: home },
          listBindings: async () => bindings,
          readState: async (binding) => {
            if (binding?.profile === "fenceproof") {
              return baseState({
                running: true,
                command: {
                  programArguments: [
                    process.execPath,
                    path.join(checkout, "dist", "index.js"),
                    "gateway",
                  ],
                },
                runtime: {
                  status: "running",
                  pid: 77,
                  systemd: { unit: "openclaw-gateway-fenceproof.service" },
                },
              });
            }
            return baseState({
              running: true,
              command: {
                programArguments: [
                  process.execPath,
                  path.join(other, "dist", "index.js"),
                  "gateway",
                ],
              },
              runtime: {
                status: "running",
                pid: 76,
                systemd: { unit: "openclaw-gateway.service" },
              },
            });
          },
        });
        expect(result.refuse).toBe(true);
        if (result.refuse) {
          expect(result.message).toContain("fenceproof");
          expect(result.message).toContain("openclaw update");
          expect(result.message).not.toContain("profiles default, fenceproof");
        }
      });
    },
  );

  it("names every overlapping live profile in the refusal", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-two-profiles-" }, async (tmp) => {
      await writeOpenClawPackage(tmp);
      const result = await resolveLiveManagedGatewayDistFence(tmp, {
        listBindings: async () => [
          { profile: "work", env: { OPENCLAW_PROFILE: "work" } },
          { profile: "fenceproof", env: { OPENCLAW_PROFILE: "fenceproof" } },
        ],
        readState: async (binding) =>
          baseState({
            running: true,
            command: {
              programArguments: [process.execPath, path.join(tmp, "dist", "index.js"), "gateway"],
            },
            runtime: {
              status: "running",
              pid: 99,
              systemd: { unit: `openclaw-gateway-${binding?.profile}.service` },
            },
          }),
      });
      expect(result.refuse).toBe(true);
      if (result.refuse) {
        expect(result.message).toContain("fenceproof");
        expect(result.message).toContain("work");
        expect(result.message).toContain("openclaw update");
        expect(result.message).toContain("openclaw gateway stop --profile fenceproof");
        expect(result.message).toContain("openclaw gateway stop --profile work");
      }
    });
  });

  it("refuses when only a system-scope sibling overlaps this checkout", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-system-scope-" }, async (tmp) => {
      await writeOpenClawPackage(tmp);
      const userBinding = {
        profile: "default",
        scope: "user" as const,
        systemdReadTarget: {
          scope: "user" as const,
          unitName: "openclaw-gateway.service",
          unitPath: path.join(tmp, "user", "openclaw-gateway.service"),
        },
        env: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
      };
      const systemBinding = {
        profile: "default",
        scope: "system" as const,
        systemdReadTarget: {
          scope: "system" as const,
          unitName: "openclaw-gateway.service",
          unitPath: path.join(tmp, "system", "openclaw-gateway.service"),
        },
        env: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
      };
      const inspected: Array<string | undefined> = [];
      const result = await resolveLiveManagedGatewayDistFence(tmp, {
        listBindings: async () => [userBinding, systemBinding],
        readState: async (binding) => {
          inspected.push(binding?.systemdReadTarget?.scope);
          if (binding?.scope === "system") {
            return baseState({
              running: true,
              command: {
                programArguments: [process.execPath, path.join(tmp, "dist", "index.js"), "gateway"],
              },
              runtime: {
                status: "running",
                pid: 88,
                systemd: { unit: "openclaw-gateway.service" },
              },
            });
          }
          return baseState({
            running: false,
            command: {
              programArguments: [
                process.execPath,
                path.join(tmp, "other", "dist", "index.js"),
                "gateway",
              ],
            },
            runtime: { status: "stopped", pid: undefined },
          });
        },
      });
      expect(inspected.toSorted((left, right) => (left ?? "").localeCompare(right ?? ""))).toEqual([
        "system",
        "user",
      ]);
      expect(result.refuse).toBe(true);
    });
  });

  it.skipIf(process.platform !== "linux")(
    "refuses a live system template instance while a separate user Gateway is installed",
    async () => {
      await withTestDir({ prefix: "openclaw-live-dist-template-instance-" }, async (tmp) => {
        const home = path.join(tmp, "home");
        const checkout = path.join(tmp, "checkout");
        const other = path.join(tmp, "other");
        const userDir = path.join(home, ".config", "systemd", "user");
        const systemDir = path.join(tmp, "etc", "systemd", "system");
        await writeOpenClawPackage(checkout);
        await writeOpenClawPackage(other);
        await fs.mkdir(userDir, { recursive: true });
        await fs.mkdir(systemDir, { recursive: true });
        const unitBody = [
          "[Service]",
          "ExecStart=/usr/bin/node /srv/openclaw/dist/index.js gateway",
          "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
          "Environment=OPENCLAW_SERVICE_KIND=gateway",
          "",
        ].join("\n");
        await fs.writeFile(path.join(userDir, "openclaw-gateway.service"), unitBody);
        await fs.writeFile(path.join(systemDir, "openclaw@.service"), unitBody);
        const instanceName = `openclaw@${os.userInfo().username}.service`;

        const { discoverManagedGatewayBindings } =
          await import("../../src/daemon/managed-gateway-bindings.ts");
        const bindings = await discoverManagedGatewayBindings(
          { HOME: home },
          { systemUnitDirs: [systemDir] },
        );
        expect(bindings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              scope: "user",
              systemdReadTarget: expect.objectContaining({
                unitName: "openclaw-gateway.service",
              }),
            }),
            expect.objectContaining({
              scope: "system",
              systemdReadTarget: expect.objectContaining({
                unitName: instanceName,
                unitPath: path.join(systemDir, "openclaw@.service"),
              }),
            }),
          ]),
        );

        const result = await resolveLiveManagedGatewayDistFence(checkout, {
          env: { HOME: home },
          listBindings: async () => bindings,
          readState: async (binding) => {
            const unitName = binding?.systemdReadTarget?.unitName ?? "";
            expect(unitName.endsWith("@.service")).toBe(false);
            if (binding?.scope === "system") {
              expect(unitName).toBe(instanceName);
              return baseState({
                running: true,
                command: {
                  programArguments: [
                    process.execPath,
                    path.join(checkout, "dist", "index.js"),
                    "gateway",
                  ],
                },
                runtime: { status: "running", pid: 91, systemd: { unit: instanceName } },
              });
            }
            return baseState({
              running: true,
              command: {
                programArguments: [
                  process.execPath,
                  path.join(other, "dist", "index.js"),
                  "gateway",
                ],
              },
              runtime: {
                status: "running",
                pid: 90,
                systemd: { unit: "openclaw-gateway.service" },
              },
            });
          },
        });
        expect(result.refuse).toBe(true);
        if (result.refuse) {
          expect(result.message).toContain(instanceName);
          expect(result.message).toContain("openclaw update");
        }
      });
    },
  );
});
