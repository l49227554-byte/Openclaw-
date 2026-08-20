// Dependency-free Claude catalog contracts shared by catalog and terminal ownership.

// Shared bound for free-text catalog fields such as paths and titles.
export const MAX_STRING_LENGTH = 4096;

export const CLAUDE_SESSIONS_LIST_COMMAND = "anthropic.claude.sessions.list.v1";
export const CLAUDE_SESSION_READ_COMMAND = "anthropic.claude.sessions.read.v1";
export const CLAUDE_CLI_NODE_RUN_COMMAND = "agent.cli.claude.run.v1";
export const CLAUDE_TERMINAL_RESUME_COMMAND = "anthropic.claude.terminal.resume.v1";
export const CLAUDE_TERMINAL_START_COMMAND = "anthropic.claude.terminal.start.v1";

export class ClaudeCatalogParamsError extends Error {}

// Desktop sessions share the resumable projects store with CLI sessions.
export function isResumableClaudeSource(source: string | undefined): boolean {
  return source === "claude-cli" || source === "claude-desktop";
}
