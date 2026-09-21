// This loaded source literal survives package replacement. It only gates a native
// argv on its private pipe; it does not load A/B modules or interpret update grants.
// The gate and controller remain under the existing runner's process-tree custody.
export const updateCommandNativeGate = `
  const { spawn } = await import("node:child_process");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 36) process.exit(1);
  }
  if (!/^[0-9a-f-]{36}$/.test(input)) process.exit(1);
  const child = spawn(process.argv[1], process.argv.slice(2), {
    stdio: ["ignore", "inherit", "inherit"], detached: false, windowsHide: true,
  });
  let spawnFailed = false;
  child.once("error", (error) => {
    spawnFailed = true;
    const code = typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "_";
    process.stderr.write("native-spawn-error:" + input + ":" + code);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    if (spawnFailed) return;
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
`;
