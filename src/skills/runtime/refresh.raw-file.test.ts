import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion } from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

type SkillsChangeEvent = NonNullable<Parameters<typeof bumpSkillsSnapshotVersion>[0]>;

const { createdWatchers, watchMock, watchForSkillRoot } = createSkillsWatcherMock();

vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

let refreshModule: typeof import("./refresh.js");
let fixtureWorkspaceDir: string;

describe("ensureSkillsWatcher", () => {
  const fixture = useSkillsWatcherFixture();
  const { createFixtureDirectory } = fixture;

  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
  });

  beforeEach(() => {
    watchMock.mockClear();
    createdWatchers.length = 0;
    fixtureWorkspaceDir = fixture.workspaceDir;
  });

  it("does not double-refresh polling SKILL.md changes from raw events", async () => {
    vi.useFakeTimers();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-polling-raw-"));
    const previousPolling = process.env.CHOKIDAR_USEPOLLING;
    const seen: SkillsChangeEvent[] = [];
    try {
      process.env.CHOKIDAR_USEPOLLING = "true";
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({
        workspaceDir,
        config: { skills: { load: {} } },
      });

      seen.length = 0;
      watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit(
        "raw",
        "change",
        path.join(workspaceDir, "skills", "demo", "SKILL.md"),
        {
          watchedPath: path.join(workspaceDir, "skills", "demo"),
        },
      );
      await vi.advanceTimersByTimeAsync(500);

      expect(seen).toEqual([]);
    } finally {
      if (previousPolling === undefined) {
        delete process.env.CHOKIDAR_USEPOLLING;
      } else {
        process.env.CHOKIDAR_USEPOLLING = previousPolling;
      }
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("refreshes snapshots from raw directory events for SKILL.md files", async () => {
    vi.useFakeTimers();
    const workspaceDir = fixtureWorkspaceDir;
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    seen.length = 0;
    watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit(
      "raw",
      "rename",
      "README.md",
      {
        watchedPath: path.join(fixtureWorkspaceDir, "skills", "demo"),
      },
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);

    watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit("raw", "rename", "SKILL.md", {
      watchedPath: path.join(fixtureWorkspaceDir, "skills", "demo"),
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      {
        workspaceDir,
        reason: "watch",
        changedPath: path.join(fixtureWorkspaceDir, "skills", "demo", "SKILL.md"),
      },
    ]);
  });

  it("falls back to a watched-directory refresh when raw events omit a filename", async () => {
    vi.useFakeTimers();
    const workspaceDir = fixtureWorkspaceDir;
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    seen.length = 0;
    watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit("raw", "rename", undefined, {
      watchedPath: path.join(fixtureWorkspaceDir, "skills"),
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      {
        workspaceDir,
        reason: "watch",
        changedPath: path.join(fixtureWorkspaceDir, "skills"),
      },
    ]);
  });

  it("coalesces raw SKILL.md bursts while renewing stability for unchanged metadata", async () => {
    vi.useFakeTimers();
    const workspaceDir = await createFixtureDirectory("watch-stable");
    const skillDir = path.join(workspaceDir, "skills", "demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    const seen: SkillsChangeEvent[] = [];
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFile, "---\nname: demo\ndescription: Demo\n---\n");
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    const watcher = watchForSkillRoot(path.join(workspaceDir, "skills")).watcher;
    const stat = vi.spyOn(fsSync, "statSync");
    const emitRaw = () => watcher.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    seen.length = 0;
    emitRaw();
    await vi.advanceTimersByTimeAsync(249);
    // Raw events can renew a write without a different size or filesystem timestamp.
    for (let event = 0; event < 32; event += 1) {
      emitRaw();
    }
    await vi.advanceTimersByTimeAsync(499);
    expect(seen).toEqual([]);

    await vi.advanceTimersByTimeAsync(102);
    expect(seen).toEqual([
      {
        workspaceDir,
        reason: "watch",
        changedPath: skillFile,
      },
    ]);
    // The burst must not multiply filesystem polling by the number of events.
    expect(stat.mock.calls.filter(([file]) => file === skillFile).length).toBeLessThanOrEqual(10);
  });

  it("stabilizes a recreated skill when raw events arrive before the missing-file continuation", async () => {
    vi.useFakeTimers();
    const skillDir = await createFixtureDirectory("workspace/skills/recreated");
    const skillFile = path.join(skillDir, "SKILL.md");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    const watcher = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher;
    seen.length = 0;

    watcher.emit("raw", "rename", "SKILL.md", { watchedPath: skillDir });
    // Keep recreation in this turn, after the missing stat and before its caller resumes.
    fsSync.writeFileSync(skillFile, "recreated skill content");
    watcher.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    await vi.advanceTimersByTimeAsync(499);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath: skillFile },
    ]);
  });

  it("refreshes a stable skill while another file in the same watcher keeps changing", async () => {
    vi.useFakeTimers();
    const firstDir = await createFixtureDirectory("workspace/skills/first");
    const secondDir = await createFixtureDirectory("workspace/skills/second");
    const firstFile = path.join(firstDir, "SKILL.md");
    const secondFile = path.join(secondDir, "SKILL.md");
    await fs.writeFile(firstFile, "stable skill");
    await fs.writeFile(secondFile, "changing skill");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    const watcher = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher;
    seen.length = 0;
    watcher.emit("raw", "change", "SKILL.md", { watchedPath: firstDir });
    watcher.emit("raw", "change", "SKILL.md", { watchedPath: secondDir });

    for (let write = 0; write < 6; write += 1) {
      await fs.appendFile(secondFile, " still writing");
      watcher.emit("raw", "change", "SKILL.md", { watchedPath: secondDir });
      await vi.advanceTimersByTimeAsync(100);
    }
    const firstChange = {
      workspaceDir: fixtureWorkspaceDir,
      reason: "watch",
      changedPath: firstFile,
    };
    expect(seen).toEqual([firstChange]);
    await vi.advanceTimersByTimeAsync(600);
    expect(seen).toEqual([
      firstChange,
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath: secondFile },
    ]);
  });

  it("retires raw-file stability polling without publishing after watchers close", async () => {
    vi.useFakeTimers();
    const skillDir = await createFixtureDirectory("workspace/skills/demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillFile, "skill content");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    const watched = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills"));
    const versionBefore = getSkillsSnapshotVersion(fixtureWorkspaceDir);
    const stat = vi.spyOn(fsSync, "statSync");

    seen.length = 0;
    watched.watcher.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    await refreshModule.closeSkillsWatchers();
    expect(watched.watcher.close).toHaveBeenCalledOnce();
    stat.mockClear();
    for (let tick = 0; tick < 4; tick += 1) {
      await fs.appendFile(skillFile, " still writing");
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(seen).toEqual([]);
    expect(getSkillsSnapshotVersion(fixtureWorkspaceDir)).toBe(versionBefore);
    expect({
      postCloseReads: stat.mock.calls.filter(([file]) => file === skillFile).length,
      pendingTimers: vi.getTimerCount(),
    }).toEqual({ postCloseReads: 0, pendingTimers: 0 });
  });

  it("lets a replacement watcher refresh a file while retired raw polling settles", async () => {
    vi.useFakeTimers();
    const skillDir = await createFixtureDirectory("workspace/skills/replaced");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillFile, "replacement skill content");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    const params = { workspaceDir: fixtureWorkspaceDir };
    refreshModule.ensureSkillsWatcher(params);
    const previous = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher;
    previous.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    await refreshModule.closeSkillsWatchers();
    refreshModule.ensureSkillsWatcher(params);
    const replacement = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher;
    expect(replacement).not.toBe(previous);
    expect(previous.closed).toBe(true);
    seen.length = 0;

    replacement.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    await vi.advanceTimersByTimeAsync(499);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath: skillFile },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
