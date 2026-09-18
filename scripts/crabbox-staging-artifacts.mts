import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

export function preserveCrabboxArtifacts(childCwd: string, repoRoot: string) {
  if (childCwd === repoRoot) {
    return;
  }
  const sourceRoot = resolve(childCwd, ".crabbox");
  if (!crabboxArtifactDirectoryExists(sourceRoot)) {
    return;
  }
  const directories = ["runs", "captures"].filter((name) => {
    const source = resolve(sourceRoot, name);
    return crabboxArtifactDirectoryExists(source) && readdirSync(source).length > 0;
  });
  if (directories.length === 0) {
    return;
  }

  // Native artifacts reuse lease names. Keep each invocation together without
  // overwriting earlier evidence, and copy only outputs, never other Crabbox state.
  const retainedRoot = resolve(repoRoot, ".crabbox", "wrapper-artifacts");
  for (const directory of [dirname(retainedRoot), retainedRoot]) {
    if (!crabboxArtifactDirectoryExists(directory)) {
      mkdirSync(directory, { mode: 0o700 });
    }
  }
  const destination = mkdtempSync(resolve(retainedRoot, "run-"));
  try {
    for (const name of directories) {
      copyCrabboxArtifact(resolve(sourceRoot, name), resolve(destination, name));
    }
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  console.error(
    `[crabbox] preserved temporary artifacts: ${sourceRoot} -> ${relative(repoRoot, destination)}`,
  );
}

function crabboxArtifactDirectoryExists(directory: string) {
  const info = lstatSync(directory, { throwIfNoEntry: false });
  if (info && !info.isDirectory()) {
    throw new Error(`artifact path must be a real directory: ${directory}`);
  }
  return Boolean(info);
}

function copyCrabboxArtifact(source: string, destination: string) {
  // Links can escape the output allowlist or point back into the deleted capsule.
  // Copy only regular files and real directories; diagnostics remain private bytes.
  const info = lstatSync(source);
  if (info.isDirectory()) {
    mkdirSync(destination, { mode: 0o700 });
    for (const entry of readdirSync(source)) {
      copyCrabboxArtifact(resolve(source, entry), resolve(destination, entry));
    }
  } else if (info.isFile()) {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, 0o600);
  } else {
    throw new Error(`artifact must be a regular file or directory: ${source}`);
  }
}
