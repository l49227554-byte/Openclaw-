import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("releases closed shared database wrappers after path and global retirement", () => {
  const moduleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
  const cacheModuleUrl = new URL("./openclaw-state-db-cache.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import {
      closeOpenClawStateDatabase,
      openOpenClawStateDatabase,
    } from ${JSON.stringify(moduleUrl)};
    import { closeOpenClawStateDatabaseByPath } from ${JSON.stringify(cacheModuleUrl)};

    const control = new WeakRef({ uncached: true });
    function retire(byPath) {
      let owner = openOpenClawStateDatabase();
      const ref = new WeakRef(owner.db);
      for (let i = 0; i < 3; i++) {
        assert.equal(openOpenClawStateDatabase(), owner);
      }
      if (byPath) {
        assert.equal(closeOpenClawStateDatabaseByPath(owner.path), true);
      } else {
        closeOpenClawStateDatabase();
      }
      assert.equal(owner.db.isOpen, false);
      owner = undefined;
      return ref;
    }
    const refs = [retire(true), retire(false)];
    for (let i = 0; i < 30; i++) {
      await new Promise(setImmediate);
      globalThis.gc();
    }
    assert.equal(control.deref(), undefined, "the unowned GC control must be collected");
    process.stdout.write(JSON.stringify(refs.map(ref => ref.deref() === undefined)));
  `;
  const observations: boolean[][] = [];
  // JSC conservatively scans stack/register values, so one object address can
  // remain pinned for a process lifetime. Fresh children distinguish that pin
  // from a cache owner, which would retain the wrapper on every attempt.
  const attempts = process.versions.bun ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const stateDir = tempDirs.make("openclaw-state-retention-");
    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--expose-gc",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const observation = JSON.parse(result.stdout) as boolean[];
    observations.push(observation);
    if (observation.every(Boolean)) {
      break;
    }
  }
  expect(observations.some((observation) => observation.every(Boolean))).toBe(true);
});
