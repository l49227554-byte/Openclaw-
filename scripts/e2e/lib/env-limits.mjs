// Environment limit helpers for E2E subprocess scenarios.
//
// Node collapses a timer delay above 2_147_000_000 ms to 1 ms, so limits handed
// to setTimeout need their own ceiling; byte, port, and count limits must stay
// unbounded by it. These helpers run under plain `node`, which does not resolve
// the workspace tsconfig alias for @openclaw/normalization-core, so the bound
// mirrors MAX_TIMER_TIMEOUT_MS from that owner and the e2e helper test pins the
// two together.
export const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

export function readPositiveIntEnv(name, fallback, env = process.env) {
  const raw = env[name] ?? fallback;
  const text = raw == null ? "unset" : String(raw).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

export function readTcpPortEnv(name, fallback, env = process.env) {
  const value = readPositiveIntEnv(name, fallback, env);
  if (value > 65_535) {
    const raw = env[name] ?? fallback;
    const text = raw == null ? "unset" : String(raw).trim();
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

// Opt-in timer bound for callers that hand the value to setTimeout.
export function readTimerMsEnv(name, fallback, env = process.env) {
  const value = readPositiveIntEnv(name, fallback, env);
  if (value > MAX_TIMER_TIMEOUT_MS) {
    const raw = env[name] ?? fallback;
    const text = raw == null ? "unset" : String(raw).trim();
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

export function readPositiveIntEnvWithEmptyFallback(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  return parsed;
}
