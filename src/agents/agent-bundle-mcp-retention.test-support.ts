import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import { createUnitFastVitestConfig } from "../../test/vitest/vitest.unit-fast.config.js";

const memoryTest = "src/auto-reply/reply/agent-runner-memory.private-transcript.test.ts";

class MemoryBeforeRequesterSequencer extends BaseSequencer {
  override async sort(files: Parameters<BaseSequencer["sort"]>[0]) {
    return files.toSorted(
      (a, b) => Number(b.moduleId.endsWith(memoryTest)) - Number(a.moduleId.endsWith(memoryTest)),
    );
  }
}

const config = createUnitFastVitestConfig();
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: [memoryTest, "src/agents/cli-runner/bundle-mcp.requester-lifecycle.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    isolate: false,
    passWithNoTests: false,
    sequence: { sequencer: MemoryBeforeRequesterSequencer },
  },
});
