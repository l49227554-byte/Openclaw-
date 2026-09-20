// Doctor migration that removes saved blank agent agentDir values, mirroring the
// load-time and write-path blank-agentDir migrations so recovery/doctor repair
// keeps older saved configurations loadable, writable, and recoverable.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const BLANK_AGENTDIR_RULE: LegacyConfigRule = {
  path: ["agents"],
  message:
    'agents agentDir must not be blank; omit the key to use the default agent directory. Run "openclaw doctor --fix".',
};

function isBlankString(value: unknown): value is string {
  return typeof value === "string" && !value.trim();
}

export const LEGACY_CONFIG_MIGRATION_AGENTS_BLANK_AGENTDIR = defineLegacyConfigMigration({
  id: "agents.blank-agentdir",
  describe: "Remove blank agent agentDir values",
  legacyRules: [BLANK_AGENTDIR_RULE],
  apply: (raw, changes) => {
    const agents = getRecord(raw.agents);
    if (agents === null) {
      return;
    }
    const removeFromAgent = (entry: unknown, path: string) => {
      const record = getRecord(entry);
      if (record !== null && isBlankString(record.agentDir)) {
        delete record.agentDir;
        changes.push(`Removed blank agents.${path}.agentDir; the default agent directory applies.`);
      }
    };
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
