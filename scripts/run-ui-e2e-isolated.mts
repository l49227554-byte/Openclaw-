#!/usr/bin/env node
// Prepared local inputs only: this runner never installs, builds, pulls, or configures Podman.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runManagedCommand, signalExitCode } from "./lib/managed-child-process.mts";
import {
  assertIsolatedContainerInputs,
  type IsolatedVolume,
} from "./lib/ui-e2e-isolated-container.mts";
import {
  CONFIG,
  inside,
  sourcePath,
  parseArgs,
  artifactRoots,
  stageInputs,
  assertPrepared,
  browserInput,
} from "./lib/ui-e2e-isolated-inputs.mts";

const OWNER_LABEL = "openclaw.ui-e2e-owner";
const CONTAINER_ID = /^[a-f0-9]{64}$/u;
const SOURCE_INPUT = /\.(?:[cm]?[jt]sx?|json|ya?ml|sh)$/u;
const SOURCE_ROOT = /^(?:scripts|src|test|ui|packages|extensions)\//u;
type CommandResult = { code: number; stdout: string };
type CommandOptions = { stream?: boolean; logFile?: string; cleanup?: boolean };
type Command = (args: string[], options?: CommandOptions) => Promise<CommandResult>;
type SignalSource = {
  on(signal: NodeJS.Signals, handler: () => void): unknown;
  off(signal: NodeJS.Signals, handler: () => void): unknown;
};

export async function runUiE2eIsolated(
  argv = process.argv.slice(2),
  options: {
    root?: string;
    env?: NodeJS.ProcessEnv;
    run?: typeof runManagedCommand;
    platform?: NodeJS.Platform;
    signals?: SignalSource;
  } = {},
): Promise<number> {
  const { image, output: rawOutput, filters } = parseArgs(argv);
  if (
    (options.platform ?? process.platform) !== "linux" ||
    !process.getuid ||
    !process.getgid ||
    process.getuid() === 0
  ) {
    throw new Error(
      "Isolated UI E2E requires Linux and an already installed local rootless Podman; no setup is performed.",
    );
  }
  const root = fs.realpathSync(
    options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const env = options.env ?? process.env;
  const run = options.run ?? runManagedCommand;
  const uid = process.getuid();
  const gid = process.getgid();
  // Only engine discovery/storage facts survive on the host. Nothing from this
  // environment is inherited by the container (including image ENV defaults).
  const hostEnv: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: os.homedir(),
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
  };
  let receivedSignal: NodeJS.Signals | undefined;
  const command = async (
    bin: string,
    args: string[],
    { stream = false, logFile, cleanup = false }: CommandOptions = {},
  ): Promise<CommandResult> => {
    if (stream && !logFile) {
      throw new Error("Attached commands require an owned log file");
    }
    const outputFd = stream && logFile ? fs.openSync(logFile, "a") : undefined;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const capture = new AbortController();
    const record = (chunk: Buffer, output: "stdout" | "stderr") => {
      if (capture.signal.aborted) {
        return;
      }
      try {
        if (output === "stdout") {
          stdoutBytes += chunk.length;
          if (stdoutBytes > 16 * 1024 * 1024) {
            throw new Error("Input/engine metadata exceeded its 16 MiB capture budget");
          }
          stdout.push(Buffer.from(chunk));
        }
        if (logFile) {
          fs.appendFileSync(logFile, chunk);
        }
      } catch (error) {
        capture.abort(error);
      }
    };
    try {
      const code = await run({
        bin,
        args,
        cwd: root,
        env: hostEnv,
        signal: capture.signal,
        stdio: outputFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", outputFd, outputFd],
        requireProcessTreeExit: bin === "git",
        timeoutMs: stream ? undefined : 60_000,
        signalHandling: cleanup ? "caller" : "forward",
        onSignal: (signal) => {
          receivedSignal ??= signal;
        },
        onReady(child) {
          if (outputFd === undefined) {
            child.stdout?.on("data", (chunk: Buffer) => record(chunk, "stdout"));
            child.stderr?.on("data", (chunk: Buffer) => record(chunk, "stderr"));
          }
        },
      });
      capture.signal.throwIfAborted();
      return { code, stdout: Buffer.concat(stdout).toString("utf8") };
    } finally {
      if (outputFd !== undefined) {
        fs.closeSync(outputFd);
      }
    }
  };
  const git = async (args: string[]) => {
    const result = await command("git", args);
    if (result.code !== 0) {
      throw new Error(`Git input admission failed (${result.code}): git ${args.join(" ")}`);
    }
    return args.includes("-z") ? result.stdout : result.stdout.trim();
  };
  const tracked = new Set(
    (await git(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean).map(sourcePath),
  );
  const artifacts = artifactRoots(root, tracked);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  const missing = untracked.find(
    (file) =>
      SOURCE_ROOT.test(file) &&
      SOURCE_INPUT.test(file) &&
      !artifacts.some((directory) => file.startsWith(`${directory}/`)),
  );
  if (missing) {
    throw new Error(
      `Untracked executable input ${missing}; run git add -- ${JSON.stringify(missing)} before launching (scratch is never copied).`,
    );
  }
  const head = await git(["rev-parse", "HEAD"]);
  assertPrepared(root, tracked, head);
  const uiTests = [...tracked].filter(
    (file) =>
      file.endsWith(".e2e.test.ts") &&
      (file.startsWith("ui/src/") ||
        /^extensions\/[^/]+\/browser\//u.test(file) ||
        file.startsWith("extensions/qa-lab/src/")),
  );
  for (const filter of filters) {
    if (!uiTests.some((file) => file.includes(filter))) {
      throw new Error(
        `No indexed UI E2E file matches ${filter}; check the filter or git add the new test.`,
      );
    }
  }
  const browser = browserInput(root, env);
  const podman: Command = (args, opts) => command("podman", ["--remote=false", ...args], opts);
  const info = await podman(["info", "--format", "{{json .Host.Security}}"]);
  let security: unknown;
  try {
    security = JSON.parse(info.stdout);
  } catch {
    security = undefined;
  }
  if (
    info.code !== 0 ||
    !security ||
    typeof security !== "object" ||
    !("rootless" in security) ||
    security.rootless !== true
  ) {
    throw new Error(
      "A working local rootless Podman is required; install/configure it separately. No remote engine or fallback is used.",
    );
  }
  if (!("selinuxEnabled" in security) || security.selinuxEnabled !== false) {
    throw new Error(
      "This launcher does not support SELinux-confined bind mounts. Host labels and security policy were not changed; use an existing supported test environment.",
    );
  }
  const inspected = await podman(["image", "inspect", "--format", "{{.Id}}", image]);
  if (inspected.code !== 0 || inspected.stdout.trim().replace(/^sha256:/u, "") !== image.slice(7)) {
    throw new Error(`Existing immutable image ${image} is unavailable; no image is pulled.`);
  }
  if (receivedSignal) {
    return signalExitCode(receivedSignal);
  }
  const requestedOutput = path.resolve(rawOutput);
  const output = path.join(
    fs.realpathSync(path.dirname(requestedOutput)),
    path.basename(requestedOutput),
  );
  if (artifacts.some((directory) => inside(path.join(root, directory), output))) {
    throw new Error("Output must be outside every admitted artifact tree.");
  }
  // An exclusive leaf proves ownership; never reuse or empty an operator directory.
  fs.mkdirSync(output, { mode: 0o700 });
  const logFile = path.join(output, "run.log");
  fs.writeFileSync(logFile, "", { flag: "wx", mode: 0o600 });
  const snapshot = path.join(output, "input");
  const artifactsOutput = path.join(output, ".artifacts");
  const home = path.join(output, "home");
  for (const directory of [snapshot, artifactsOutput, home]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  for (const file of [output, process.execPath, browser.cache]) {
    if (/[,:\n\r]/u.test(file)) {
      throw new Error(`Unsupported mount path: ${file}`);
    }
  }
  stageInputs(root, snapshot, tracked, artifacts);
  assertPrepared(snapshot, tracked, head);
  fs.mkdirSync(path.join(snapshot, ".artifacts"), { recursive: true });
  const owner = randomUUID();
  const cidfile = path.join(output, "container.cid");
  const name = "openclaw-ui-e2e-" + owner;
  const volumes: IsolatedVolume[] = [
    { source: snapshot, destination: "/work", readonly: true },
    { source: artifactsOutput, destination: "/work/.artifacts", readonly: false },
    { source: home, destination: "/home/runner", readonly: false },
    { source: process.execPath, destination: "/usr/local/bin/node", readonly: true },
    { source: browser.cache, destination: "/browsers", readonly: true },
  ];
  const containerEnv = [
    "HOME=/home/runner",
    "TMPDIR=/tmp",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "LANG=C.UTF-8",
    "CI=1",
    "PLAYWRIGHT_BROWSERS_PATH=/browsers",
    `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${browser.executable}`,
    "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
    "OPENCLAW_UI_E2E_REQUIRE_BROWSER=1",
    "OPENCLAW_E2E_USE_PREBUILT_DIST=1",
    "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/work/.artifacts/vitest-module-cache",
  ];
  const containerArgs = [
    "/usr/local/bin/node",
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    CONFIG,
    "--configLoader",
    "runner",
    ...filters,
  ];
  const args = [
    "create",
    "--name",
    name,
    "--pull=never",
    "--network=none",
    "--pid=private",
    "--ipc=private",
    "--uts=private",
    "--cgroupns=private",
    "--http-proxy=false",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--image-volume=ignore",
    "--userns=keep-id",
    "--user",
    `${uid}:${gid}`,
    "--memory=8g",
    "--cpus=4",
    "--pids-limit=2048",
    "--shm-size=512m",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=2g,mode=1777",
    "--unsetenv-all",
    "--workdir=/work",
    "--hostname=openclaw-ui-e2e",
    "--entrypoint=/usr/local/bin/node",
    "--cidfile",
    cidfile,
    "--label",
    `${OWNER_LABEL}=${owner}`,
    ...volumes.flatMap((volume) => [
      "--volume",
      volume.source + ":" + volume.destination + (volume.readonly ? ":ro" : ":rw"),
    ]),
    ...containerEnv.flatMap((value) => ["--env", value]),
    image,
    ...containerArgs.slice(1),
  ];
  const readOwnedId = async (target: string, cleanup = false) => {
    const ownership = await podman(
      ["inspect", "--format", '{{.Id}} {{index .Config.Labels "openclaw.ui-e2e-owner"}}', target],
      { cleanup },
    );
    const [id] = ownership.stdout.trim().split(" ");
    if (
      ownership.code !== 0 ||
      !id ||
      !CONTAINER_ID.test(id) ||
      ownership.stdout.trim() !== id + " " + owner ||
      (CONTAINER_ID.test(target) && id !== target)
    ) {
      throw new Error("Refusing cleanup without exact container ownership: " + target);
    }
    return id;
  };
  const signalSource = options.signals ?? process;
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
    const handler = () => {
      receivedSignal ??= signal;
    };
    signalSource.on(signal, handler);
    return { signal, handler };
  });
  // Managed commands own child termination; this guard spans the gaps between
  // those commands until the container's removal is positively verified.
  try {
    let exit = 1;
    let createAttempted = false;
    let failure: Error | undefined;
    try {
      if (!receivedSignal) {
        createAttempted = true;
        const created = await podman(args, { logFile });
        if (created.code !== 0 && !receivedSignal) {
          throw new Error(`Podman create failed (${created.code}); see ${logFile}`);
        }
        if (!receivedSignal) {
          const id = fs.readFileSync(cidfile, "utf8").trim();
          if (!CONTAINER_ID.test(id) || created.stdout.trim() !== id) {
            throw new Error("Podman create did not return the owned immutable container ID.");
          }
          await readOwnedId(id);
          if (!receivedSignal) {
            const initialized = await podman(["init", id], { logFile });
            if (initialized.code !== 0) {
              throw new Error("Podman initialization failed; tests were not started.");
            }
          }
          if (!receivedSignal) {
            const inspection = await podman(["inspect", id]);
            if (inspection.code !== 0) {
              throw new Error("Initialized container inspection failed; tests were not started.");
            }
            assertIsolatedContainerInputs(inspection.stdout, {
              id,
              owner,
              volumes,
              env: containerEnv,
              args: containerArgs,
            });
          }
          if (!receivedSignal) {
            exit = (await podman(["start", "--attach", id], { stream: true, logFile })).code;
          }
        }
      }
    } catch (error) {
      failure = receivedSignal
        ? undefined
        : error instanceof Error
          ? error
          : new Error("Isolated command failed", { cause: error });
    }
    // A create can commit before writing its cidfile. Reconcile the invocation's
    // unique name too, and require a fresh ID/label match before any removal.
    try {
      let id: string | undefined;
      if (createAttempted && fs.existsSync(cidfile)) {
        const candidate = fs.readFileSync(cidfile, "utf8").trim();
        if (!CONTAINER_ID.test(candidate)) {
          throw new Error("Invalid owned container ID; inputs retained for manual inspection.");
        }
        id = await readOwnedId(candidate, true);
      } else if (createAttempted) {
        const presence = await podman(["container", "exists", name], { cleanup: true });
        if (presence.code === 0) {
          id = await readOwnedId(name, true);
        } else if (presence.code !== 1) {
          throw new Error("Container creation outcome is unknown: " + name);
        }
      }
      if (id) {
        const removed = await podman(["rm", "--force", "--time", "10", id], { cleanup: true });
        const exists = await podman(["container", "exists", id], { cleanup: true });
        if (removed.code !== 0 || exists.code !== 1) {
          throw new Error("Owned container cleanup is unverified: " + id + "; retained " + output);
        }
      }
    } catch (error) {
      failure = new AggregateError(
        failure ? [failure, error] : [error],
        "UI E2E cleanup failed; retained " + output,
      );
    }
    if (failure) {
      throw failure;
    }
    return receivedSignal ? signalExitCode(receivedSignal) : exit;
  } finally {
    for (const { signal, handler } of handlers) {
      signalSource.off(signal, handler);
    }
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = await runUiE2eIsolated();
    console.log(
      "UI E2E finished (exit " +
        process.exitCode +
        "); see the requested output directory for run.log and artifacts.",
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
