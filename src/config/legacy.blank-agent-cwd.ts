// Load-time migration that preserves saved configurations with blank agent cwd
// values. A blank `cwd` (whitespace-only) was historically accepted: the
// runtime trimmed it and fell back to the default cwd. Once blank cwd is
// surfaced as a validation error, a saved blank would reject config loading
// entirely. This migration removes such blanks during load so existing
// installations keep loading and keep their effective (defaulted) cwd.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getRetainedLegacyDefaultAgentId,
  setRetainedLegacyDefaultAgentId,
} from "./legacy.default-agent-owner-state.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.openclaw.js";

type BlankCwdMigration<T = unknown> = {
  config: T;
  changed: boolean;
  changes: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
};

function isBlankString(value: unknown): value is string {
  return typeof value === "string" && !value.trim();
}

function removeBlankCwdFromAgent(
  record: Record<string, unknown>,
  path: string,
  changes: ConfigValidationIssue[],
): void {
  if (isRecord(record) && isBlankString(record.cwd)) {
    delete record.cwd;
    changes.push({ path, message: `Removed blank agents.${path}.cwd; the default cwd applies.` });
  }
}

function migrateBlankAgentCwdRaw(raw: unknown): BlankCwdMigration {
  if (!isRecord(raw) || !isRecord(raw.agents)) {
    return { config: raw, changed: false, changes: [], warnings: [] };
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  // structuredClone drops the retained-legacy-owner WeakMap association that
  // the preceding roster migration attached to the root config. Preserve it on
  // the cloned root so multi-agent configs with a legacy default marker keep
  // loading (AgentsSchema relies on the retained owner during validation).
  if (isRecord(raw)) {
    setRetainedLegacyDefaultAgentId(next, getRetainedLegacyDefaultAgentId(raw));
  }
  const agents = isRecord(next.agents) ? (next.agents as Record<string, unknown>) : {};
  const changes: ConfigValidationIssue[] = [];

  if (isRecord(agents.defaults) && isBlankString(agents.defaults.cwd)) {
    delete agents.defaults.cwd;
    changes.push({ path: "agents.defaults.cwd", message: "Removed blank agents.defaults.cwd." });
  }

  if (isRecord(agents.entries)) {
    for (const [key, entry] of Object.entries(agents.entries)) {
      removeBlankCwdFromAgent(entry as Record<string, unknown>, `entries.${key}`, changes);
    }
  }

  if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      removeBlankCwdFromAgent(entry as Record<string, unknown>, `list[${index}]`, changes);
    }
  }

  return changes.length > 0
    ? { config: next, changed: true, changes, warnings: [] }
    : { config: raw, changed: false, changes, warnings: [] };
}

export function migrateBlankAgentCwd(raw: OpenClawConfig): BlankCwdMigration<OpenClawConfig>;
export function migrateBlankAgentCwd(raw: unknown): BlankCwdMigration;
export function migrateBlankAgentCwd(raw: unknown): BlankCwdMigration {
  return migrateBlankAgentCwdRaw(raw);
}
