import type { DatabaseSync } from "node:sqlite";
import { verifyAndRepairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  AGENT_MEDIA_SCHEMA_VERSION,
  AGENT_PARTICIPANT_IDENTITY_SCHEMA_VERSION,
  AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import { assertAgentDatabaseMaintenanceAuthority } from "./openclaw-agent-db-lease.js";
import {
  assertAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  readSqliteTableColumns,
  withoutSessionRecipientAuthoritySchema,
} from "./openclaw-agent-db-session-migrations.js";
import { withLegacySessionParticipantsSchema } from "./openclaw-agent-participants-migration.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

export function resolveOpenClawAgentTargetSchema(targetVersion: number): string {
  let schemaSql = OPENCLAW_AGENT_SCHEMA_SQL;
  if (targetVersion < AGENT_PARTICIPANT_IDENTITY_SCHEMA_VERSION) {
    schemaSql = withLegacySessionParticipantsSchema(schemaSql);
  }
  if (targetVersion < AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION) {
    schemaSql = withoutSessionRecipientAuthoritySchema(schemaSql);
  }
  return schemaSql;
}

function hasSessionRecipientAuthoritySchema(database: DatabaseSync): boolean {
  return readSqliteTableColumns(database, "session_recipient_authority") !== null;
}

function hasLegacySessionParticipantsSchema(database: DatabaseSync): boolean {
  return (
    tableExists(database, "session_participants") &&
    tableHasColumn(database, "session_participants", "actor_type") &&
    !tableHasColumn(database, "session_participants", "identity_namespace")
  );
}

function resolveExistingAgentSchemaVariant(
  database: DatabaseSync,
  version: number,
): { schemaSql: string; participantSchema: "current" | "legacy" } {
  let schemaSql = OPENCLAW_AGENT_SCHEMA_SQL;
  const participantSchema =
    version < AGENT_PARTICIPANT_IDENTITY_SCHEMA_VERSION ||
    hasLegacySessionParticipantsSchema(database)
      ? "legacy"
      : "current";
  if (participantSchema === "legacy") {
    schemaSql = withLegacySessionParticipantsSchema(schemaSql);
  }
  if (
    version < AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION &&
    !hasSessionRecipientAuthoritySchema(database)
  ) {
    schemaSql = withoutSessionRecipientAuthoritySchema(schemaSql);
  }
  return { schemaSql, participantSchema };
}

export function assertOpenClawAgentMigrationInput(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  const existingVersion = readSqliteUserVersion(database);
  if (
    existingVersion < AGENT_MEDIA_SCHEMA_VERSION ||
    existingVersion >= OPENCLAW_AGENT_SCHEMA_VERSION
  ) {
    return;
  }
  assertAgentDatabaseMaintenanceAuthority();
  if (readExistingAgentSchemaMeta(database)?.schemaVersion !== existingVersion) {
    throw new Error(
      `Agent schema markers disagree for ${options.pathname}; repair ownership metadata before migration.`,
    );
  }
  const existingSchema = resolveExistingAgentSchemaVariant(database, existingVersion);
  // Keep canonical index recovery reachable before rebuilding either v18 input shape.
  verifyAndRepairCanonicalSqliteIndexes(database, options.pathname, existingSchema.schemaSql, {
    allowMissingColumns: true,
    validateAfterRepair: () =>
      assertAgentSchemaVersion(
        database,
        { ...options, version: existingVersion },
        existingSchema.schemaSql,
        existingSchema.participantSchema,
      ),
  });
}
