import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { runUiE2eIsolated } from "../../scripts/run-ui-e2e-isolated.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const image = `sha256:${"a".repeat(64)}`;
const id = "b".repeat(64);
const head = "c".repeat(40);
const testFile = "ui/src/e2e/example.e2e.test.ts";
type RunOptions = Parameters<typeof runManagedCommand>[0];

function fixture() {
  const directory = tempDirs.make("ui-e2e-isolated-");
  const root = path.join(directory, "repo");
  const output = path.join(directory, "output");
  const cache = path.join(directory, "browsers");
  const tracked = [
    "package.json",
    "scripts/run-ui-e2e-isolated.mts",
    "scripts/run-vitest.mjs",
    "scripts/tsx.mjs",
    "test/vitest/vitest.ui-e2e.config.ts",
    testFile,
    "packages/example/package.json",
    "packages/example/src/index.ts",
    "extensions/example/package.json",
  ];
  const put = (file: string, contents = "prepared input") => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  for (const file of tracked) {
    put(path.join(root, file), file.endsWith("package.json") ? "{}" : "current working bytes");
  }
  for (const file of [
    "dist/entry.js",
    "dist/control-ui/index.html",
    "node_modules/vitest/vitest.mjs",
    "packages/example/dist/index.js",
    "extensions/example/dist/index.js",
    "extensions/example/node_modules/dependency/index.js",
  ]) {
    put(path.join(root, file));
  }
  put(
    path.join(root, "node_modules/playwright-core/package.json"),
    JSON.stringify({ name: "playwright-core" }),
  );
  put(
    path.join(root, "node_modules/playwright-core/browsers.json"),
    JSON.stringify({ browsers: [{ name: "chromium", revision: "1234" }] }),
  );
  put(path.join(root, "node_modules/.pnpm/dependency/node_modules/dependency/index.js"));
  fs.mkdirSync(path.join(root, "packages/example/node_modules"));
  fs.symlinkSync(
    "../../../node_modules/.pnpm/dependency/node_modules/dependency",
    path.join(root, "packages/example/node_modules/dependency"),
  );
  fs.symlinkSync("../packages/example", path.join(root, "node_modules/example"));
  for (const stamp of [".buildstamp", ".runtime-postbuildstamp"]) {
    const file = path.join(root, "dist", stamp);
    put(file, JSON.stringify({ head, inputsClean: true }));
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(file, future, future);
  }
  const folder = process.arch === "arm64" ? "chrome-linux-arm64" : "chrome-linux64";
  const browser = path.join(cache, "chromium-1234", folder, "chrome");
  put(browser);
  fs.chmodSync(browser, 0o755);
  for (const file of [
    ".git/config",
    ".env",
    ".local/credentials.json",
    ".openclaw/state.sqlite",
    ".artifacts/private.log",
    "scratch/private.ts",
  ]) {
    put(path.join(root, file), "PRIVATE_SENTINEL");
  }
  const calls: RunOptions[] = [];
  const signals = new EventEmitter();
  const state = {
    rootless: "true",
    selinux: false,
    cleanupSignal: undefined as "inspect" | "rm" | "container" | undefined,
    started: false,
    injectedInput: undefined as
      | "bind"
      | "environment"
      | "hook"
      | "writable-source"
      | "missing-source"
      | undefined,
    initCode: 0,
    cleanupInterrupted: false,
    imageId: image,
    untracked: [] as string[],
    startCode: 0,
    createCode: 0,
    writeCid: true,
    splitMetadata: false,
    betweenSignal: undefined as NodeJS.Signals | undefined,
    createdExistsCode: 0,
    existsCode: 1,
    ownership: true,
    signal: undefined as NodeJS.Signals | undefined,
    startError: undefined as Error | undefined,
  };
  let label = "";
  let createArgs: string[] = [];
  const staticDir = path.join(directory, id, "userdata");
  const configPath = path.join(staticDir, "config.json");
  const run: typeof runManagedCommand = async (options) => {
    calls.push(options);
    const child = new ChildProcess();
    const outputFd =
      Array.isArray(options.stdio) && typeof options.stdio[1] === "number"
        ? options.stdio[1]
        : undefined;
    child.stdout = outputFd === undefined ? new PassThrough() : null;
    child.stderr = outputFd === undefined ? new PassThrough() : null;
    options.onReady?.(child);
    const respond = (stdout: string, code = 0) => {
      const bytes = Buffer.from(stdout);
      if (outputFd !== undefined) {
        fs.writeSync(outputFd, bytes);
      } else if (state.splitMetadata && options.bin === "git") {
        for (const byte of bytes) {
          child.stdout?.emit("data", Buffer.from([byte]));
        }
      } else {
        child.stdout?.emit("data", bytes);
      }
      return code;
    };
    const args = options.args ?? [];
    if (options.bin === "git") {
      if (args[0] === "rev-parse") {
        return respond(head);
      }
      if (args.includes("--cached")) {
        return respond(tracked.join("\0") + "\0");
      }
      if (args.includes("--others")) {
        return respond(state.untracked.join("\0"));
      }
    }
    expect(options.bin).toBe("podman");
    expect(args[0]).toBe("--remote=false");
    if (state.started && state.cleanupSignal === args[1] && !state.cleanupInterrupted) {
      state.cleanupInterrupted = true;
      signals.emit("SIGTERM");
      if (options.signalHandling !== "caller") {
        options.onSignal?.("SIGTERM");
        return respond("", 143);
      }
    }
    switch (args[1]) {
      case "info":
        return respond(
          JSON.stringify({ rootless: state.rootless === "true", selinuxEnabled: state.selinux }),
        );
      case "image":
        return respond(state.imageId + "\n");
      case "create": {
        createArgs = [...args];
        const encodedLabel = args[args.indexOf("--label") + 1];
        const cidfile = args[args.indexOf("--cidfile") + 1];
        if (!encodedLabel || !cidfile) {
          throw new Error("Expected owned label and cidfile arguments");
        }
        expect(encodedLabel.startsWith("openclaw.ui-e2e-owner=")).toBe(true);
        label = encodedLabel.slice("openclaw.ui-e2e-owner=".length);
        if (state.writeCid) {
          fs.writeFileSync(cidfile, id);
        }
        if (state.betweenSignal) {
          signals.emit(state.betweenSignal);
        }
        return respond(id + "\n", state.createCode);
      }
      case "init": {
        const mounts = createArgs.flatMap((value, index) => {
          if (value !== "--volume") return [];
          const [source, destination, mode] = createArgs[index + 1]!.split(":");
          return [{ source: fs.realpathSync(source!), destination, type: "bind", options: [mode] }];
        });
        const env = createArgs.flatMap((value, index) =>
          value === "--env" ? [createArgs[index + 1]] : [],
        );
        env.push("HOSTNAME=openclaw-ui-e2e");
        if (state.injectedInput === "bind")
          mounts.push({
            source: directory,
            destination: "/run/secrets",
            type: "bind",
            options: ["ro"],
          });
        if (state.injectedInput === "environment") env.push("INJECTED=SECRET_SENTINEL");
        if (state.injectedInput === "writable-source") mounts[0]!.options = ["rw"];
        if (state.injectedInput === "missing-source") mounts.shift();
        put(
          configPath,
          JSON.stringify({
            process: {
              env,
              args: ["/usr/local/bin/node", ...createArgs.slice(createArgs.indexOf(image) + 1)],
              cwd: "/work",
            },
            mounts,
            ...(state.injectedInput === "hook"
              ? { hooks: { startContainer: [{ path: "/injected" }] } }
              : {}),
          }),
        );
        return respond(id, state.initCode);
      }
      case "inspect":
        if (args.includes("--format"))
          return respond(id + " " + (state.ownership ? label : "not-our-container"));
        return respond(
          JSON.stringify([
            {
              Id: id,
              State: { Status: "initialized" },
              Config: { Labels: { "openclaw.ui-e2e-owner": label } },
              StaticDir: staticDir,
              OCIConfigPath: configPath,
              HostsPath: path.join(staticDir, "hosts"),
              HostnamePath: path.join(staticDir, "hostname"),
              ResolvConfPath: "",
            },
          ]),
        );
      case "start": {
        state.started = true;
        if (state.signal) {
          options.onSignal?.(state.signal);
        }
        if (state.startError) {
          throw state.startError;
        }
        return respond("owned test output\n", state.startCode);
      }
      case "rm":
        expect(signals.listenerCount("SIGTERM")).toBe(1);
        return respond(id + "\n");
      case "container":
        return respond("", args[3] === id ? state.existsCode : state.createdExistsCode);
      default:
        throw new Error("Unexpected engine command " + args.join(" "));
    }
  };
  const launch = (filters: string[] = [testFile]) =>
    runUiE2eIsolated(["--image", image, "--output", output, "--", ...filters], {
      root,
      run,
      signals,
      platform: "linux",
      env: {
        PATH: "/usr/bin:/bin",
        PLAYWRIGHT_BROWSERS_PATH: cache,
        OPENCLAW_STATE_DIR: "/private/gateway",
        OPENAI_API_KEY: "SECRET_SENTINEL",
        NODE_OPTIONS: "--require=/private/inject.js",
        CONTAINER_HOST: "ssh://remote",
        HTTPS_PROXY: "http://private-proxy",
        SSH_AUTH_SOCK: "/private/agent.sock",
      },
    });
  return { root, output, cache, browser, tracked, calls, state, launch, put, signals };
}

beforeEach(() => {
  if (process.getuid && process.getgid) {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    vi.spyOn(process, "getgid").mockReturnValue(1000);
  }
});
afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("isolated UI E2E entry admission", () => {
  it("stages indexed working bytes plus prepared artifacts, excluding private scratch and Git metadata", async () => {
    const f = fixture();
    await expect(f.launch()).resolves.toBe(0);
    const input = path.join(f.output, "input");
    expect(fs.readFileSync(path.join(input, testFile), "utf8")).toBe("current working bytes");
    for (const file of [
      ".git",
      ".env",
      ".local",
      ".openclaw",
      "scratch",
      ".artifacts/private.log",
    ]) {
      expect(fs.existsSync(path.join(input, file)), file).toBe(false);
    }
    expect(
      fs.readFileSync(
        path.join(input, "packages/example/node_modules/dependency/index.js"),
        "utf8",
      ),
    ).toBe("prepared input");
    expect(fs.readFileSync(path.join(input, "node_modules/example/dist/index.js"), "utf8")).toBe(
      "prepared input",
    );
    expect(
      fs.existsSync(path.join(input, "extensions/example/node_modules/dependency/index.js")),
    ).toBe(true);
    expect(fs.readFileSync(path.join(f.output, "run.log"), "utf8")).toContain("owned test output");
  });

  it("preserves indexed UTF-8 paths across metadata chunk boundaries", async () => {
    const f = fixture();
    const file = "ui/src/components/unicode-λ.ts";
    f.tracked.push(file);
    f.put(path.join(f.root, file), "unicode input");
    f.state.splitMetadata = true;
    await expect(f.launch()).resolves.toBe(0);
    expect(fs.readFileSync(path.join(f.output, "input", file), "utf8")).toBe("unicode input");
  });

  it("pins argv, namespaces, resources, read-only inputs and a clean environment", async () => {
    const f = fixture();
    await f.launch();
    const args = f.calls.find((call) => call.args?.[1] === "create")?.args ?? [];
    for (const flag of [
      "--pull=never",
      "--network=none",
      "--http-proxy=false",
      "--cap-drop=all",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--image-volume=ignore",
      "--userns=keep-id",
      "--memory=8g",
      "--cpus=4",
      "--pids-limit=2048",
      "--shm-size=512m",
      "--unsetenv-all",
    ]) {
      expect(args).toContain(flag);
    }
    expect(args).toContain("1000:1000");
    expect(args).toContain("/tmp:rw,nosuid,nodev,size=2g,mode=1777");
    const mounts = args.flatMap((value, index) => (value === "--volume" ? [args[index + 1]] : []));
    expect(mounts).toEqual([
      path.join(f.output, "input") + ":/work:ro",
      path.join(f.output, ".artifacts") + ":/work/.artifacts:rw",
      path.join(f.output, "home") + ":/home/runner:rw",
      process.execPath + ":/usr/local/bin/node:ro",
      f.cache + ":/browsers:ro",
    ]);
    expect(args.slice(args.indexOf(image) + 1)).toEqual([
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      "test/vitest/vitest.ui-e2e.config.ts",
      "--configLoader",
      "runner",
      testFile,
    ]);
    expect(args.join(" ")).not.toMatch(
      /SECRET_SENTINEL|private-proxy|agent\.sock|cpuset|--privileged|network=host/u,
    );
    for (const call of f.calls) {
      expect(call.env).not.toHaveProperty("NODE_OPTIONS");
      expect(call.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(call.env).not.toHaveProperty("CONTAINER_HOST");
      expect(call.env).not.toHaveProperty("HTTPS_PROXY");
    }
  });

  it.each(["--config", "../escape", "/absolute", "*.test.ts", "run;command"])(
    "refuses unsafe filter %s before invoking tools",
    async (filter) => {
      const f = fixture();
      await expect(f.launch([filter])).rejects.toThrow();
      expect(f.calls).toEqual([]);
    },
  );

  it("requires new executable inputs to be indexed, rather than silently running old coverage", async () => {
    const f = fixture();
    f.state.untracked.push("ui/src/e2e/new.e2e.test.ts");
    await expect(f.launch()).rejects.toThrow(/git add --.*new\.e2e/u);
    expect(f.calls.some((call) => call.bin === "podman")).toBe(false);
  });

  it("refuses a missing indexed input and preserves private inputs", async () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.root, testFile));
    await expect(f.launch()).rejects.toThrow(/restore it or stage its deletion/u);
    expect(f.calls.some((call) => call.args?.[1] === "create")).toBe(false);
    expect(fs.readFileSync(path.join(f.root, ".env"), "utf8")).toBe("PRIVATE_SENTINEL");
  });

  it("refuses source and artifact links outside the admitted snapshot", async () => {
    const f = fixture();
    fs.symlinkSync("../.env", path.join(f.root, "node_modules/secret"));
    await expect(f.launch()).rejects.toThrow(/symlink leaves admitted/u);
    expect(f.calls.some((call) => call.args?.[1] === "create")).toBe(false);
  });

  it.each(["dist/.buildstamp", "dist/control-ui/index.html"])(
    "requires prepared %s",
    async (file) => {
      const f = fixture();
      fs.unlinkSync(path.join(f.root, file));
      await expect(f.launch()).rejects.toThrow(/missing/u);
      expect(f.calls.some((call) => call.bin === "podman")).toBe(false);
    },
  );

  it("fails missing browsers before an ordinary UI missing-browser skip can hide the failure", async () => {
    const f = fixture();
    fs.unlinkSync(f.browser);
    await expect(f.launch()).rejects.toThrow(/Chromium missing/u);
    expect(f.calls.some((call) => call.bin === "podman")).toBe(false);
  });

  it("rejects stale build stamps before starting an engine", async () => {
    const f = fixture();
    const changed = path.join(f.root, "package.json");
    const future = new Date(Date.now() + 20_000);
    fs.utimesSync(changed, future, future);
    await expect(f.launch()).rejects.toThrow(/predates source/u);
    expect(f.calls.some((call) => call.bin === "podman")).toBe(false);
  });

  it.each(["rootful", "wrong-image"])(
    "refuses %s engines without creating a container",
    async (failure) => {
      const f = fixture();
      if (failure === "rootful") {
        f.state.rootless = "false";
      } else {
        f.state.imageId = "sha256:" + "d".repeat(64);
      }
      await expect(f.launch()).rejects.toThrow();
      expect(f.calls.some((call) => call.args?.[1] === "create")).toBe(false);
      expect(fs.existsSync(f.output)).toBe(false);
    },
  );

  it("refuses unsupported SELinux confinement without changing labels or policy", async () => {
    const f = fixture();
    f.state.selinux = true;
    await expect(f.launch()).rejects.toThrow(/SELinux-confined/);
    expect(f.calls.some((call) => call.args?.[1] === "create")).toBe(false);
    expect(fs.existsSync(f.output)).toBe(false);
  });

  it.each(["bind", "environment", "hook", "writable-source", "missing-source"] as const)(
    "rejects effective %s injection before execution and removes the owned container",
    async (injection) => {
      const f = fixture();
      f.state.injectedInput = injection;
      await expect(f.launch()).rejects.toThrow(/inputs differ from.*allowlist/);
      expect(f.calls.some((call) => call.args?.[1] === "start")).toBe(false);
      expect(f.calls.at(-1)?.args).toEqual(["--remote=false", "container", "exists", id]);
      expect(fs.readFileSync(path.join(f.output, "run.log"), "utf8")).not.toContain(
        "SECRET_SENTINEL",
      );
    },
  );

  it("cleans a failed initialization without starting tests", async () => {
    const f = fixture();
    f.state.initCode = 125;
    await expect(f.launch()).rejects.toThrow(/initialization failed/);
    expect(f.calls.some((call) => call.args?.[1] === "start")).toBe(false);
    expect(f.calls.at(-1)?.args).toEqual(["--remote=false", "container", "exists", id]);
  });

  it("does not reuse an existing output directory", async () => {
    const f = fixture();
    fs.mkdirSync(f.output);
    f.put(path.join(f.output, "keep"), "operator-owned");
    await expect(f.launch()).rejects.toThrow(/EEXIST/u);
    expect(fs.readFileSync(path.join(f.output, "keep"), "utf8")).toBe("operator-owned");
  });
});

describe.skipIf(process.platform === "win32")("owned container completion", () => {
  it.each([0, 7, 143])("preserves exit %i after joining exact-ID removal", async (code) => {
    const f = fixture();
    f.state.startCode = code;
    await expect(f.launch()).resolves.toBe(code);
    expect(f.calls.at(-2)?.args).toEqual(["--remote=false", "rm", "--force", "--time", "10", id]);
    expect(f.calls.at(-1)?.args).toEqual(["--remote=false", "container", "exists", id]);
  });

  it("preserves signals after exact owned cleanup", async () => {
    const f = fixture();
    f.state.signal = "SIGINT";
    await expect(f.launch()).resolves.toBe(130);
    expect(f.calls.at(-1)?.args).toEqual(["--remote=false", "container", "exists", id]);
  });

  it("retains signal ownership between create and later managed commands", async () => {
    const f = fixture();
    f.state.betweenSignal = "SIGTERM";
    await expect(f.launch()).resolves.toBe(143);
    expect(f.calls.some((call) => call.args?.[1] === "start")).toBe(false);
    expect(f.calls.at(-1)?.args).toEqual(["--remote=false", "container", "exists", id]);
    expect(f.signals.eventNames()).toEqual([]);
  });

  it.each(["inspect", "rm", "container"] as const)(
    "finishes bounded cleanup despite a signal during %s",
    async (step) => {
      const f = fixture();
      f.state.cleanupSignal = step;
      await expect(f.launch()).resolves.toBe(143);
      expect(f.state.cleanupInterrupted).toBe(true);
      expect(f.calls.at(-1)?.args).toEqual(["--remote=false", "container", "exists", id]);
      expect(f.signals.eventNames()).toEqual([]);
    },
  );

  it("does not forward to caller pipes while a container is owned", async () => {
    const f = fixture();
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw Object.assign(new Error("closed caller pipe"), { code: "EPIPE" });
    });
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw Object.assign(new Error("closed caller pipe"), { code: "EPIPE" });
    });
    try {
      await expect(f.launch()).resolves.toBe(0);
      expect(output).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(f.output, "run.log"), "utf8")).toContain(
        "owned test output",
      );
    } finally {
      output.mockRestore();
      errors.mockRestore();
    }
  });

  it("cleans a committed container even when create reports failure", async () => {
    const f = fixture();
    f.state.createCode = 125;
    await expect(f.launch()).rejects.toThrow(/create failed/u);
    expect(f.calls.some((call) => call.args?.[1] === "start")).toBe(false);
    expect(f.calls.at(-1)?.args).toEqual(["--remote=false", "container", "exists", id]);
  });

  it("reconciles a committed create that failed before writing its cidfile", async () => {
    const f = fixture();
    f.state.createCode = 125;
    f.state.writeCid = false;
    await expect(f.launch()).rejects.toThrow(/create failed/u);
    expect(f.calls.some((call) => call.args?.[1] === "rm")).toBe(true);
    expect(f.calls.at(-1)?.args).toEqual(["--remote=false", "container", "exists", id]);
  });

  it("preserves an uncertain create outcome when the engine cannot check its name", async () => {
    const f = fixture();
    f.state.createCode = 125;
    f.state.writeCid = false;
    f.state.createdExistsCode = 125;
    await expect(f.launch()).rejects.toThrow(/cleanup failed/u);
    expect(f.calls.some((call) => call.args?.[1] === "rm")).toBe(false);
  });

  it("cleans after a spawn failure while preserving the original error", async () => {
    const f = fixture();
    f.state.startError = new Error("start transport failed");
    await expect(f.launch()).rejects.toBe(f.state.startError);
    expect(f.calls.at(-1)?.args).toEqual(["--remote=false", "container", "exists", id]);
  });

  it("never removes a container without current exact-ID ownership", async () => {
    const f = fixture();
    f.state.ownership = false;
    await expect(f.launch()).rejects.toThrow(/cleanup failed/u);
    expect(f.calls.some((call) => call.args?.[1] === "rm")).toBe(false);
  });

  it("does not report success when removal is unverified", async () => {
    const f = fixture();
    f.state.existsCode = 0;
    await expect(f.launch()).rejects.toThrow(/cleanup failed/u);
    expect(fs.existsSync(path.join(f.output, "run.log"))).toBe(true);
  });
});
