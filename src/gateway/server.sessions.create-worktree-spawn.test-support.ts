import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const execFileAsync = promisify(execFile);

export function useWorktreeSpawnRepositoryTemplate(getCaseRoot: () => string) {
  const repositoryTemplates = useAutoCleanupTempDirTracker(afterAll);
  let repositoryTemplate: string;
  beforeAll(async () => {
    repositoryTemplate = repositoryTemplates.make("openclaw-spawn-repo-template-");
    await fs.mkdir(path.join(repositoryTemplate, ".openclaw"));
    await fs.writeFile(path.join(repositoryTemplate, "README.md"), "selected-project\n");
    await fs.writeFile(
      path.join(repositoryTemplate, ".openclaw", "worktree-setup.sh"),
      "#!/bin/sh\ntouch setup-marker.txt\n",
      { mode: 0o755 },
    );
    await execFileAsync("git", ["init", "-b", "main", repositoryTemplate]);
    await execFileAsync("git", ["-C", repositoryTemplate, "add", "."]);
    await execFileAsync("git", [
      "-C",
      repositoryTemplate,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Initialize fixture",
    ]);
  });

  return async function createRepository(name: string): Promise<string> {
    const root = path.join(getCaseRoot(), name);
    await fs.mkdir(path.dirname(root), { recursive: true });
    await execFileAsync("git", ["clone", "--shared", repositoryTemplate, root]);
    await execFileAsync("git", ["-C", root, "remote", "remove", "origin"]);
    if (name !== "selected-project") {
      // Distinct committed contents keep the source-selection assertions meaningful.
      await fs.writeFile(path.join(root, "README.md"), `${name}\n`);
      await execFileAsync("git", [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-am",
        "Name fixture source",
      ]);
    }
    return await fs.realpath(root);
  };
}
