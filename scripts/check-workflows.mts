#!/usr/bin/env node
import type { StdioOptions } from "node:child_process";
// Runs local workflow sanity checks.
// Uses installed tools when present, otherwise falls back to pinned hooks where
// possible, then runs repo-specific workflow guards.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runManagedCommand } from "./lib/managed-child-process.mts";

const ACTIONLINT_REVISION = "011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7";
const PRE_COMMIT_VERSION = "4.6.2";
// pre-commit 4.6.2 declares requires-python >=3.10, so an older interpreter only
// fails after a venv build and a network pip install.
const PRE_COMMIT_PYTHON_FLOOR = "3.10";
const WORKFLOW_DIR = ".github/workflows";
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
// Dependency bootstrap (Go module fetch, temporary-venv pip install, and
// pre-commit hook-environment setup) is network- and disk-bound and can
// legitimately exceed the linter budget on a slow network. Keep it bounded to
// prevent indefinite hangs, but with its own longer budget so healthy slow
// downloads are not treated as stalled scans.
const BOOTSTRAP_COMMAND_TIMEOUT_MS = 15 * 60_000;

type CommandError = Error & { code?: string; timeoutMs?: number };
type SpawnCommandOptions = { timeoutMs?: number; stdio?: StdioOptions };
type SpawnCommandResult = {
  error: CommandError | null;
  signal: null;
  status: number | null;
  timedOut: boolean;
  timeoutMs: number;
};

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function normalizeCommandError(error: unknown): CommandError {
  if (error instanceof Error) {
    return error as CommandError;
  }
  return new Error(String(error));
}

async function spawnCommand(
  command: string,
  args: readonly string[],
  options: SpawnCommandOptions = {},
): Promise<SpawnCommandResult> {
  // Delegate the timeout, process-tree teardown, Windows shell normalization,
  // and validated System32 taskkill resolution to the repository's canonical
  // managed child-process runner.
  const { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, stdio = "inherit" } = options;
  try {
    const status = await runManagedCommand({ bin: command, args: [...args], stdio, timeoutMs });
    return { error: null, signal: null, status, timedOut: false, timeoutMs };
  } catch (error) {
    const commandError = normalizeCommandError(error);
    if (commandError.code === "ETIMEDOUT") {
      commandError.timeoutMs = timeoutMs;
    }
    return {
      error: commandError,
      signal: null,
      status: null,
      timedOut: commandError.code === "ETIMEDOUT",
      timeoutMs,
    };
  }
}

async function main() {
  const workflows = workflowFiles();

  if (await commandExists("actionlint")) {
    await run("actionlint", workflows);
  } else if (await commandExists("go", ["version"])) {
    await run("go", ["run", `github.com/rhysd/actionlint/cmd/actionlint@${ACTIONLINT_REVISION}`], {
      timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS,
    });
  } else if (
    (await commandExists("pre-commit")) ||
    (await commandExists("python3", ["-m", "pre_commit", "--version"])) ||
    (await commandExists("python3", ["--version"]))
  ) {
    await runPreCommitHook("actionlint", workflows);
  } else {
    console.error(
      `[check-workflows] missing workflow linter: install actionlint, Go for actionlint@${ACTIONLINT_REVISION}, or pre-commit.`,
    );
    process.exit(1);
  }

  await runPreCommitHook("zizmor", workflows);
  await run("node", ["scripts/generate-ci-git-owner.mts", "--check"]);
  await run("python3", ["scripts/check-composite-action-input-interpolation.py"]);
  await run("node", ["scripts/check-no-conflict-markers.mjs"]);
}

function commandFailureMessage(
  command: string,
  args: readonly string[],
  error: CommandError,
): string {
  if (error.code === "ETIMEDOUT") {
    return `[check-workflows] timed out after ${error.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS}ms: ${commandLabel(command, args)}`;
  }
  return `[check-workflows] failed to run ${command}: ${error.message}`;
}

async function commandExists(
  command: string,
  args: readonly string[] = ["--version"],
): Promise<boolean> {
  const result = await spawnCommand(command, args, { stdio: "ignore" });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      return false;
    }
    console.error(commandFailureMessage(command, args, result.error));
    process.exit(1);
  }
  // The managed runner resolves a SIGINT/SIGTERM cancellation to status 130 or
  // 143 after tearing down the process tree. Treat that outcome as a stop
  // request: exit with it instead of reporting the tool as unavailable, so the
  // checker never starts fallback work after the caller asked to terminate.
  if (result.status === 130 || result.status === 143) {
    process.exit(result.status);
  }
  return !result.error && result.status === 0;
}

function isBelowPythonFloor(version: string, floor: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number(part));
  const [floorMajor = 0, floorMinor = 0] = floor.split(".").map((part) => Number(part));
  return major < floorMajor || (major === floorMajor && minor < floorMinor);
}

async function probePythonVersion(
  command: string,
): Promise<{ runnable: false } | { runnable: true; version?: string }> {
  // Route the interpreter probe through the same bounded managed runner as
  // every other subprocess; capture its version banner without inheriting
  // the scan's own output streams.
  let output = "";
  try {
    const status = await runManagedCommand({
      bin: command,
      args: ["--version"],
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      onReady: (child) => {
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          output += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          output += chunk;
        });
      },
    });
    // A SIGINT/SIGTERM cancellation resolves to status 130 or 143; stop the
    // checker with the signal outcome instead of hiding it behind
    // "runtime unavailable".
    if (status === 130 || status === 143) {
      process.exit(status);
    }
    if (status !== 0) {
      return { runnable: false };
    }
  } catch (error) {
    const commandError = normalizeCommandError(error);
    if (commandError.code === "ENOENT") {
      // Only expected interpreter absence becomes an unavailable runtime.
      return { runnable: false };
    }
    // Preserve the command and timeout diagnostic, as the other discovery
    // paths do, instead of degrading a probe timeout into "missing runtime".
    console.error(commandFailureMessage(command, ["--version"], commandError));
    process.exit(1);
  }
  const match = /Python (\d+\.\d+(?:\.\d+)?)/u.exec(output);
  const version = match?.[1];
  return version ? { runnable: true, version } : { runnable: true };
}

async function run(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const result = await spawnCommand(command, args, { stdio: "inherit", ...options });
  if (result.error) {
    console.error(commandFailureMessage(command, args, result.error));
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function runChecked(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
) {
  const result = await spawnCommand(command, args, { stdio: "inherit", ...options });
  if (result.error) {
    return {
      message: commandFailureMessage(command, args, result.error),
      status: 1,
    };
  }
  if (result.status !== 0) {
    return {
      message: null,
      status: result.status ?? 1,
    };
  }
  return null;
}

function exitWithFailure(failure: NonNullable<Awaited<ReturnType<typeof runChecked>>>): never {
  if (failure.message) {
    console.error(failure.message);
  }
  process.exit(failure.status);
}

async function runPreCommitFromTempVenv(hookArgs: string[]): Promise<boolean> {
  const pythonProbe = await probePythonVersion("python3");
  if (!pythonProbe.runnable) {
    return false;
  }
  if (pythonProbe.version && isBelowPythonFloor(pythonProbe.version, PRE_COMMIT_PYTHON_FLOOR)) {
    console.error(
      `[check-workflows] python3 is ${pythonProbe.version}, but pre-commit ${PRE_COMMIT_VERSION} requires Python >=${PRE_COMMIT_PYTHON_FLOOR}. Install a newer python3 or a pre-commit runtime.`,
    );
    process.exit(1);
  }
  const venvDir = mkdtempSync(join(tmpdir(), "openclaw-check-workflows-pre-commit-"));
  const python = join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  let postVenvFailure: Awaited<ReturnType<typeof runChecked>> = null;
  try {
    const venvFailure = await runChecked("python3", ["-m", "venv", venvDir], {
      timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS,
    });
    if (venvFailure) {
      // Preserve spawn/timeout diagnostics from the bounded venv bootstrap
      // instead of falling back to the generic missing-runtime message.
      // Ordinary nonzero venv exits keep the existing fallback behavior.
      if (venvFailure.message) {
        postVenvFailure = venvFailure;
      }
      return false;
    }
    postVenvFailure = await runChecked(
      python,
      ["-m", "pip", "install", "--disable-pip-version-check", `pre-commit==${PRE_COMMIT_VERSION}`],
      { timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS },
    );
    if (postVenvFailure) {
      return false;
    }
    postVenvFailure = await runChecked(python, ["-m", "pre_commit", ...hookArgs], {
      timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS,
    });
    if (postVenvFailure) {
      return false;
    }
    return true;
  } finally {
    rmSync(venvDir, { force: true, recursive: true });
    if (postVenvFailure) {
      exitWithFailure(postVenvFailure);
    }
  }
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .toSorted()
    .map((file) => join(WORKFLOW_DIR, file));
}

async function runPreCommitHook(hook: string, files: string[]): Promise<void> {
  const hookArgs = ["run", "--config", ".pre-commit-config.yaml", hook, "--files", ...files];
  if (await commandExists("pre-commit")) {
    await run("pre-commit", hookArgs, { timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS });
    return;
  }
  if (await commandExists("python3", ["-m", "pre_commit", "--version"])) {
    await run("python3", ["-m", "pre_commit", ...hookArgs], {
      timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS,
    });
    return;
  }
  if (await runPreCommitFromTempVenv(hookArgs)) {
    return;
  }

  console.error(
    `[check-workflows] missing pre-commit runtime for ${hook}: install pre-commit or Python venv support for pre-commit ${PRE_COMMIT_VERSION}.`,
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
