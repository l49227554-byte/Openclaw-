// Doctor migration that removes saved blank agent cwd values, mirroring the
// load-time and write-path blank-cwd migrations so recovery/doctor repair keeps
// older saved configurations loadable, writable, and recoverable.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const BLANK_CWD_RULE: LegacyConfigRule = {
  path: ["agents"],
  message:
    'agents cwd must not be blank; omit the key to inherit the default cwd. Run "openclaw doctor --fix".',
  match: (value) => hasBlankAgentCwd(value),
};

function isBlankString(value: unknown): value is string {
  return typeof value === "string" && !value.trim();
}

/** True when any agent entry/list entry/default has a blank cwd value. */
function hasBlankAgentCwd(value: unknown): boolean {
  const agents = getRecord(value);
  if (agents === null) {
    return false;
  }
  const agentHasBlankCwd = (entry: unknown) => {
    const record = getRecord(entry);
    return record !== null && isBlankString(record.cwd);
  };
  const defaults = getRecord(agents.defaults);
  if (defaults !== null && isBlankString(defaults.cwd)) {
    return true;
  }
  const entries = getRecord(agents.entries);
  if (entries !== null && Object.values(entries).some(agentHasBlankCwd)) {
    return true;
  }
  return Array.isArray(agents.list) && agents.list.some(agentHasBlankCwd);
}

export const LEGACY_CONFIG_MIGRATION_AGENTS_BLANK_CWD = defineLegacyConfigMigration({
  id: "agents.blank-cwd",
  describe: "Remove blank agent cwd values",
  legacyRules: [BLANK_CWD_RULE],
  apply: (raw, changes) => {
    const agents = getRecord(raw.agents);
    if (agents === null) {
      return;
    }
    const removeFromAgent = (entry: unknown, path: string) => {
      const record = getRecord(entry);
      if (record !== null && isBlankString(record.cwd)) {
        delete record.cwd;
        changes.push(`Removed blank agents.${path}.cwd; the default cwd applies.`);
      }
    };
    const defaults = getRecord(agents.defaults);
    if (defaults !== null && isBlankString(defaults.cwd)) {
      delete defaults.cwd;
      changes.push("Removed blank agents.defaults.cwd.");
    }
    const entries = getRecord(agents.entries);
    if (entries !== null) {
      for (const [key, entry] of Object.entries(entries)) {
        removeFromAgent(entry, `entries.${key}`);
      }
    }
    if (Array.isArray(agents.list)) {
      for (const [index, entry] of agents.list.entries()) {
        removeFromAgent(entry, `list[${index}]`);
      }
    }
  },
});
