import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["runNodeCliShim", "runTsxCliShim"])(
  "%s preserves explicit compiler flags without inheriting parent loaders or eval",
  (shim) => {
    const root = tempDirs.make("openclaw-shim-compiler-");
    const implementation = path.join(root, "implementation.mts");
    fs.writeFileSync(implementation, "console.log(JSON.stringify(process.execArgv));\n");
    const preload = path.join(root, "parent-only.mjs");
    fs.writeFileSync(
      preload,
      `if (process.argv[1] === ${JSON.stringify(implementation)}) throw new Error("Parent preload reached the child");\n`,
    );
    const compilerFlags = [
      "--maglev",
      "--concurrent-sparkplug",
      "--no-maglev",
      "--no-concurrent-sparkplug",
    ];
    const explicitFlags = ["--no-maglev"];
    const shimUrl = pathToFileURL(path.resolve("scripts/lib/tsx-cli-shim.mjs")).href;
    const result = spawnSync(
      resolveTestNodeExecPath(),
      [
        ...compilerFlags,
        "--import",
        pathToFileURL(preload).href,
        "--input-type=module",
        "--eval",
        `import { ${shim} } from ${JSON.stringify(shimUrl)};
await ${shim}(${JSON.stringify(pathToFileURL(path.join(root, "entry.mjs")).href)}, {
  implementation: "./implementation.mts", execArgv: ${JSON.stringify(explicitFlags)}, detached: false,
});`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      ...compilerFlags,
      ...(shim === "runTsxCliShim"
        ? ["--import", pathToFileURL(path.resolve("scripts/tsx.mjs")).href]
        : []),
      ...explicitFlags,
    ]);
  },
);
