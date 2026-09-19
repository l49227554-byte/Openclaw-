// Load-time migration that preserves saved configurations with blank agent
// agentDir values. A blank `agentDir` (whitespace-only) was historically
// accepted: the runtime trimmed it and fell back to the default per-agent
// directory. Once blank agentDir is surfaced as a validation error, a saved
// blank would reject config loading entirely. This migration removes such
// blanks during load so existing installations keep loading and keep their
// effective (defaulted) agent directory.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getRetainedLegacyDefaultAgentId,
  setRetainedLegacyDefaultAgentId,
} from "./legacy.default-agent-owner-state.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.openclaw.js";

type BlankAgentDirMigration<T = unknown> = {
  config: T;
  changed: boolean;
  changes: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
};

function isBlankString(value: unknown): value is string {
  return typeof value === "string" && !value.trim();
}

function removeBlankAgentDirFromAgent(
  record: Record<string, unknown>,
  path: string,
  changes: ConfigValidationIssue[],
): void {
  if (isRecord(record) && isBlankString(record.agentDir)) {
    delete record.agentDir;
    changes.push({
      path,
      message: `Removed blank agents.${path}.agentDir; the default agent directory applies.`,
    });
  }
}

function migrateBlankAgentDirRaw(raw: unknown): BlankAgentDirMigration {
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

  if (isRecord(agents.entries)) {
    for (const [key, entry] of Object.entries(agents.entries)) {
      removeBlankAgentDirFromAgent(entry as Record<string, unknown>, `entries.${key}`, changes);
    }
  }

  if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      removeBlankAgentDirFromAgent(entry as Record<string, unknown>, `list[${index}]`, changes);
    }
  }

  return changes.length > 0
    ? { config: next, changed: true, changes, warnings: [] }
    : { config: raw, changed: false, changes, warnings: [] };
}

export function migrateBlankAgentDir(raw: OpenClawConfig): BlankAgentDirMigration<OpenClawConfig>;
export function migrateBlankAgentDir(raw: unknown): BlankAgentDirMigration;
export function migrateBlankAgentDir(raw: unknown): BlankAgentDirMigration {
  return migrateBlankAgentDirRaw(raw);
}
