import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createRunNodePathClassifier } from "../run-node-watch-paths.mts";
import { BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE } from "./local-build-metadata-paths.mts";

export const CONFIG = "test/vitest/vitest.ui-e2e.config.ts";
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;

export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function sourcePath(value: string): string {
  if (
    !value ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error(`Unsafe source path: ${value}`);
  }
  return value;
}

export function parseArgs(argv: string[]) {
  let image: string | undefined;
  let output: string | undefined;
  let filters: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      filters = argv.slice(index + 1);
      break;
    }
    if (arg === "--image" && !image) {
      image = argv[++index];
    } else if (arg === "--output" && !output) {
      output = argv[++index];
    } else {
      throw new Error(
        `Unsupported argument: ${arg}. Use --image sha256:<full-id> --output <fresh-directory> -- <UI E2E file filters>.`,
      );
    }
  }
  if (!image || !IMAGE_ID.test(image) || !output || output.startsWith("--")) {
    throw new Error(
      "An existing immutable --image sha256:<64 lowercase hex digits> and fresh --output directory are required.",
    );
  }
  if (filters.length === 0) {
    throw new Error("Select at least one UI E2E file filter after --.");
  }
  for (const filter of filters) {
    sourcePath(filter);
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/u.test(filter)) {
      throw new Error(
        `Only UI E2E file filters are accepted, not options, globs, or commands: ${filter}`,
      );
    }
  }
  return { image, output, filters };
}

function requireFile(file: string, message: string) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${message}: ${file}`);
  }
}

export function artifactRoots(root: string, tracked: Set<string>): string[] {
  const roots = new Set(["node_modules", "dist"]);
  for (const file of tracked) {
    if (/^(?:packages\/[^/]+|extensions\/[^/]+|ui)\/package\.json$/u.test(file)) {
      const directory = path.posix.dirname(file);
      for (const name of ["node_modules", "dist"]) {
        const candidate = `${directory}/${name}`;
        if (fs.existsSync(path.join(root, candidate))) {
          roots.add(candidate);
        }
      }
    }
  }
  return [...roots];
}

// Never dereference directory links while enumerating. Source membership is the Git
// index; installed/generated trees are the only explicitly admitted non-source inputs.
export function stageInputs(
  root: string,
  snapshot: string,
  tracked: Set<string>,
  artifacts: string[],
) {
  const sourceDirectories = new Set<string>();
  for (const file of tracked) {
    for (
      let directory = path.posix.dirname(file);
      directory !== ".";
      directory = path.posix.dirname(directory)
    ) {
      sourceDirectories.add(directory);
    }
  }
  const admitted = (file: string) =>
    file === "" ||
    tracked.has(file) ||
    sourceDirectories.has(file) ||
    artifacts.some((directory) => file === directory || file.startsWith(`${directory}/`));
  const links: string[] = [];
  const copy = (relative: string, recursive: boolean) => {
    sourcePath(relative);
    const from = path.join(root, relative);
    const to = path.join(snapshot, relative);
    const parent = fs.realpathSync(path.dirname(from));
    if (!inside(root, parent) || parent !== path.dirname(from)) {
      throw new Error(`Input traverses a directory symlink: ${relative}`);
    }
    const stat = fs.lstatSync(from);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(from);
      const destination = path.resolve(path.dirname(from), target);
      if (
        path.isAbsolute(target) ||
        !inside(root, destination) ||
        !admitted(path.relative(root, destination))
      ) {
        throw new Error(
          `Input symlink leaves admitted source/artifact roots: ${relative} -> ${target}`,
        );
      }
      fs.symlinkSync(target, to);
      links.push(relative);
    } else if (stat.isDirectory() && recursive) {
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from)) {
        // Dependency-manager caches and metadata are not executable artifacts.
        if (entry === ".git" || entry === ".cache" || entry === ".vite" || entry === ".vite-temp") {
          continue;
        }
        copy(`${relative}/${entry}`, true);
      }
    } else if (stat.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
      const after = fs.lstatSync(from);
      if (
        !after.isFile() ||
        after.ino !== stat.ino ||
        after.size !== stat.size ||
        after.ctimeMs !== stat.ctimeMs
      ) {
        throw new Error(`Input changed during snapshot: ${relative}`);
      }
      fs.chmodSync(to, stat.mode & 0o777);
      fs.utimesSync(to, stat.atime, stat.mtime);
    } else {
      throw new Error(`Input is not a regular file, directory, or admitted symlink: ${relative}`);
    }
  };
  for (const file of tracked) {
    if (!artifacts.some((directory) => file === directory || file.startsWith(`${directory}/`))) {
      try {
        copy(file, false);
      } catch (error) {
        throw new Error(
          `Cannot stage indexed input ${file}; restore it or stage its deletion with git add -- ${JSON.stringify(file)}`,
          { cause: error },
        );
      }
    }
  }
  for (const directory of artifacts) {
    copy(directory, true);
  }
  for (const relative of links) {
    const resolved = fs.realpathSync(path.join(snapshot, relative));
    if (!inside(snapshot, resolved)) {
      throw new Error(`Staged symlink escapes snapshot: ${relative}`);
    }
  }
}

export function assertPrepared(root: string, tracked: Set<string>, head: string) {
  for (const file of [
    "scripts/run-ui-e2e-isolated.mts",
    "scripts/run-vitest.mjs",
    "scripts/tsx.mjs",
    CONFIG,
  ]) {
    if (!tracked.has(file)) {
      throw new Error(
        `Required executable input is not indexed. Run git add -- ${file} before launching.`,
      );
    }
  }
  for (const file of [
    "node_modules/vitest/vitest.mjs",
    "dist/entry.js",
    "dist/control-ui/index.html",
  ]) {
    requireFile(
      path.join(root, file),
      "Prepared build/dependencies missing; prepare them separately before launching",
    );
  }
  const stamps = [BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE].map((name) => {
    const file = path.join(root, "dist", name);
    requireFile(file, "Prepared build stamp missing; build separately before launching");
    const stamp: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!stamp || typeof stamp !== "object" || !("head" in stamp) || stamp.head !== head) {
      throw new Error(`Prepared build stamp does not match current HEAD: ${file}`);
    }
    return fs.statSync(file).mtimeMs;
  });
  const builtAt = Math.min(...stamps);
  const classifier = createRunNodePathClassifier({ rootDir: root });
  for (const file of tracked) {
    if (
      classifier.isBuildRelevantRunNodePath(file) &&
      fs.statSync(path.join(root, file)).mtimeMs > builtAt
    ) {
      throw new Error(`Prepared build predates source ${file}; build separately before launching.`);
    }
  }
}

export function browserInput(root: string, env: NodeJS.ProcessEnv) {
  const require = createRequire(path.join(root, "package.json"));
  const manifestPath = path.join(
    path.dirname(require.resolve("playwright-core/package.json")),
    "browsers.json",
  );
  const manifest: { browsers: { name: string; revision: string }[] } = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  );
  const chromium = manifest.browsers.find((browser) => browser.name === "chromium");
  if (!chromium || !/^\d+$/u.test(chromium.revision)) {
    throw new Error("Prepared playwright-core Chromium revision is missing.");
  }
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  const cachePath =
    configured === "0"
      ? path.join(path.dirname(manifestPath), ".local-browsers")
      : configured ||
        path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright");
  if (!fs.existsSync(cachePath)) {
    throw new Error(
      `Prepared Playwright browser cache missing: ${cachePath}; prepare it separately, no downloads are performed.`,
    );
  }
  const cache = fs.realpathSync(cachePath);
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("Prepared Playwright Chromium requires Linux x64 or arm64.");
  }
  // These are the pinned Playwright registry layouts for its Linux Chromium builds.
  const folder = process.arch === "arm64" ? "chrome-linux-arm64" : "chrome-linux64";
  const executable = `chromium-${chromium.revision}/${folder}/chrome`;
  requireFile(
    path.join(cache, executable),
    "Prepared Playwright Chromium missing; install it separately before launching",
  );
  fs.accessSync(path.join(cache, executable), fs.constants.X_OK);
  // The mounted cache is an explicit trusted artifact, but may not link host files into it.
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (path.isAbsolute(fs.readlinkSync(file)) || !inside(cache, fs.realpathSync(file))) {
          throw new Error(`Browser cache symlink leaves its artifact root: ${file}`);
        }
      } else if (entry.isDirectory()) {
        walk(file);
      } else if (!entry.isFile()) {
        throw new Error(`Unsupported browser cache input: ${file}`);
      }
    }
  };
  walk(cache);
  return { cache, executable: `/browsers/${executable}` };
}
