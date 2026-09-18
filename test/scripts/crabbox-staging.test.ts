import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
const repository = fileURLToPath(new URL("../../", import.meta.url));

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

it.skipIf(process.platform === "win32")(
  "recovers a real prepared capsule after its owner dies through the public wrapper",
  async () => {
    // openclaw-temp-dir: allow retain input ownership when a child cannot be joined
    const root = mkdtempSync(join(tmpdir(), "openclaw-crabbox-recovery-"));
    let inputsSettled = true;
    const runNode = async (args: string[], env = process.env) => {
      inputsSettled = false;
      let stdout = "";
      let stderr = "";
      let signal: NodeJS.Signals | null = null;
      const status = await runManagedCommand({
        bin: process.execPath,
        args,
        cwd: repository,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: 30_000,
        requireProcessTreeExit: true,
        onReady(child) {
          child.stdout!.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          child.stderr!.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.once("exit", (_code, received) => {
            signal = received;
          });
        },
      });
      inputsSettled = true;
      return { status, signal, stdout, stderr };
    };
    try {
      const source = join(root, "source");
      const staging = join(root, "staging");
      mkdirSync(source);
      mkdirSync(staging);
      git(source, ["init", "--quiet", "--initial-branch=main", "--template="]);
      git(source, ["config", "user.name", "Fixture"]);
      git(source, ["config", "user.email", "fixture@example.invalid"]);
      git(source, ["remote", "add", "origin", "https://example.invalid/fixture.git"]);
      writeFileSync(join(source, "source.txt"), "retained source\n");
      git(source, ["add", "source.txt"]);
      git(source, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
      const before = git(source, ["rev-parse", "HEAD"]);
      const producer = new URL("../../scripts/crabbox-source-capsule.mts", import.meta.url).href;
      const child = await runNode([
        "--import",
        resolve(repository, "scripts/tsx.mjs"),
        "--input-type=module",
        "-e",
        [
          "import { prepareCrabboxSourceCapsule } from " + JSON.stringify(producer) + ";",
          "prepareCrabboxSourceCapsule({",
          "repoRoot: " + JSON.stringify(source) + ",",
          "syncRoot: " + JSON.stringify(staging) + ",",
          "base: 'HEAD',",
          "syncPlan: { command: process.execPath, args: ['-e', " +
            JSON.stringify(
              "process.stdout.write(JSON.stringify({candidate:{files:1},topFiles:[{path:'source.txt'}]}))",
            ) +
            "] }",
          "});",
          // Every synchronous producer child has joined before this deliberate loss.
          "process.kill(process.pid, 'SIGKILL');",
        ].join("\n"),
      ]);
      expect(child.signal, child.stderr).toBe("SIGKILL");
      const [name] = readdirSync(staging);
      expect(name).toMatch(/^openclaw-crabbox-sync-/u);
      const receipt = JSON.parse(readFileSync(join(staging, name!, "staging.json"), "utf8"));
      expect(receipt.state).toBe("prepared");
      expect(receipt.users).toBe("none");
      const recovery = await runNode(
        [resolve(repository, "scripts/crabbox-wrapper.mjs"), "staging", "recover", receipt.id],
        { ...process.env, OPENCLAW_CRABBOX_SYNC_TMPDIR: staging },
      );
      expect(recovery.status, recovery.stdout + recovery.stderr).toBe(0);
      expect(JSON.parse(recovery.stdout)).toMatchObject({ id: receipt.id, recovered: true });
      expect(readdirSync(staging)).toEqual([]);
      expect(readFileSync(join(source, "source.txt"), "utf8")).toBe("retained source\n");
      expect(git(source, ["rev-parse", "HEAD"])).toBe(before);
      expect(git(source, ["status", "--porcelain"])).toBe("");
    } finally {
      if (inputsSettled) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error("Recovery fixture retained after unverified child cleanup: " + root);
      }
    }
  },
  60_000,
);
