// Entrypoint descriptor for the task-registry recovery restart fixture.
// Kept separate from the runnable script (which executes at module load) so the
// test can import the descriptor without running the fixture.
export const taskRegistryRecoveryRestartEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "task-registry-recovery-restart",
  distWorkerPath: "test-support/task-registry-recovery-restart.js",
} as const;
