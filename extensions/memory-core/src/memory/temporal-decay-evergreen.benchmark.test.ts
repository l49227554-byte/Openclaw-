import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryCoreTestHarness } from "../test-helpers.js";
import { mergeHybridResults } from "./hybrid.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 8, 18);
const { createTempWorkspace } = createMemoryCoreTestHarness();

const HOLDOUT_CASES = [
  { source: "matters", matter: "atlas", ageDays: 45 },
  { source: "matters", matter: "beacon", ageDays: 90 },
  { source: "projects", matter: "cinder", ageDays: 180 },
  { source: "projects", matter: "delta", ageDays: 365 },
  { source: "runbooks", matter: "ember", ageDays: 60 },
  { source: "runbooks", matter: "fjord", ageDays: 120 },
] as const;

describe("evergreen extra-path synthetic holdout", () => {
  it.each(HOLDOUT_CASES)(
    "removes mtime bias for unseen $source/$matter reference material",
    async ({ source, matter, ageDays }) => {
      const workspaceDir = await createTempWorkspace("openclaw-evergreen-holdout-");
      const goldPath = `${source}/${matter}/authority.md`;
      const distractorPath = `updates/${matter}/summary.md`;
      const absoluteGoldPath = path.join(workspaceDir, goldPath);
      const absoluteDistractorPath = path.join(workspaceDir, distractorPath);
      await Promise.all([
        fs.mkdir(path.dirname(absoluteGoldPath), { recursive: true }),
        fs.mkdir(path.dirname(absoluteDistractorPath), { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(absoluteGoldPath, `${matter} governed reference\n`),
        fs.writeFile(absoluteDistractorPath, `${matter} recent summary\n`),
      ]);
      await fs.utimes(
        absoluteGoldPath,
        new Date(NOW_MS - ageDays * DAY_MS),
        new Date(NOW_MS - ageDays * DAY_MS),
      );

      const run = async (evergreen: boolean) =>
        await mergeHybridResults({
          vector: [
            {
              id: "gold",
              path: goldPath,
              startLine: 1,
              endLine: 1,
              source: "memory",
              snippet: `${matter} governed reference`,
              vectorScore: 0.82,
            },
            {
              id: "distractor",
              path: distractorPath,
              startLine: 1,
              endLine: 1,
              source: "memory",
              snippet: `${matter} recent summary`,
              vectorScore: 0.72,
            },
          ],
          keyword: [],
          vectorWeight: 1,
          textWeight: 0,
          workspaceDir,
          extraPaths: [evergreen ? { path: source, evergreen: true } : source, "updates"],
          temporalDecay: { enabled: true, halfLifeDays: 30 },
          mmr: { enabled: false },
          nowMs: NOW_MS,
        });

      const control = await run(false);
      const variant = await run(true);
      expect(control[0]?.path).toBe(distractorPath);
      expect(variant[0]?.path).toBe(goldPath);
      expect(variant[0]?.score).toBeCloseTo(0.82);
    },
  );
});
