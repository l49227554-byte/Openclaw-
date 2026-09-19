import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const inspectionSchema = z
  .array(
    z.object({
      Id: z.string(),
      State: z.object({ Status: z.literal("initialized") }),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      StaticDir: z.string(),
      OCIConfigPath: z.string(),
      HostsPath: z.string(),
      HostnamePath: z.string(),
      ResolvConfPath: z.string(),
    }),
  )
  .length(1);
const specSchema = z.object({
  process: z.object({ env: z.array(z.string()), args: z.array(z.string()), cwd: z.string() }),
  mounts: z.array(
    z.object({
      destination: z.string(),
      type: z.string(),
      source: z.string(),
      options: z.array(z.string()),
    }),
  ),
  hooks: z.record(z.string(), z.unknown()).optional(),
});
export type IsolatedVolume = { source: string; destination: string; readonly: boolean };

/** Inspect Podman's initialized OCI spec, including mounts.conf and config defaults,
 * before it can execute the test command. Never log unexpected values: they may be secrets. */
export function assertIsolatedContainerInputs(
  rawInspection: string,
  expected: { id: string; owner: string; volumes: IsolatedVolume[]; env: string[]; args: string[] },
): void {
  try {
    const [container] = inspectionSchema.parse(JSON.parse(rawInspection));
    if (
      !container ||
      container.Id !== expected.id ||
      container.Config.Labels["openclaw.ui-e2e-owner"] !== expected.owner ||
      path.basename(path.dirname(container.StaticDir)) !== expected.id ||
      container.OCIConfigPath !== path.join(container.StaticDir, "config.json")
    ) {
      throw new Error("ownership");
    }
    const spec = specSchema.parse(JSON.parse(fs.readFileSync(container.OCIConfigPath, "utf8")));
    const env = [...expected.env, "HOSTNAME=openclaw-ui-e2e"].toSorted();
    if (
      JSON.stringify(spec.process.env.toSorted()) !== JSON.stringify(env) ||
      JSON.stringify(spec.process.args) !== JSON.stringify(expected.args) ||
      spec.process.cwd !== "/work" ||
      (spec.hooks && Object.keys(spec.hooks).length > 0)
    ) {
      throw new Error("process");
    }
    const volumes = new Map(expected.volumes.map((volume) => [volume.destination, volume]));
    const seen = new Set<string>();
    // Only engine-generated files for this exact container may supplement explicit binds.
    const runDir = path.dirname(container.HostsPath);
    if (path.basename(path.dirname(runDir)) !== expected.id) {
      throw new Error("runtime directory");
    }
    const generated = new Map([
      ["/etc/hosts", container.HostsPath],
      ["/etc/hostname", container.HostnamePath],
      ["/etc/resolv.conf", container.ResolvConfPath],
      ["/run/.containerenv", path.join(runDir, ".containerenv")],
      ["/dev/shm", path.join(container.StaticDir, "shm")],
    ]);
    const virtual = new Map([
      ["/run", "tmpfs"],
      ["/tmp", "tmpfs"],
      ["/var/tmp", "tmpfs"],
      ["/dev", "tmpfs"],
      ["/proc", "proc"],
      ["/sys", "sysfs"],
      ["/dev/pts", "devpts"],
      ["/dev/mqueue", "mqueue"],
      ["/sys/fs/cgroup", "cgroup"],
    ]);
    for (const mount of spec.mounts) {
      if (seen.has(mount.destination)) {
        throw new Error("duplicate mount");
      }
      seen.add(mount.destination);
      const volume = volumes.get(mount.destination);
      if (volume) {
        if (
          mount.type !== "bind" ||
          mount.source !== fs.realpathSync(volume.source) ||
          mount.options.includes("ro") !== volume.readonly
        ) {
          throw new Error("explicit mount");
        }
      } else if (mount.type === "bind") {
        const source = generated.get(mount.destination);
        if (
          !source ||
          mount.source !== source ||
          (mount.destination !== "/dev/shm" && !mount.options.includes("ro"))
        ) {
          throw new Error("extra bind");
        }
      } else if (virtual.get(mount.destination) !== mount.type || mount.source !== mount.type) {
        throw new Error("extra mount");
      }
    }
    if (expected.volumes.some((volume) => !seen.has(volume.destination))) {
      throw new Error("missing mount");
    }
  } catch {
    throw new Error(
      "Initialized container inputs differ from the isolated UI E2E allowlist. Tests were not started; inspect Podman defaults separately. Host configuration and security policy were not changed.",
    );
  }
}
