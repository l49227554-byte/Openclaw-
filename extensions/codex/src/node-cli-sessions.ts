// Codex plugin module implements node cli sessions behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import { formatCodexDisplayText } from "./command-formatters.js";
import { readJsonlHead, readJsonlTail, visitJsonlLines } from "./jsonl-lines.js";

const CODEX_CLI_SESSIONS_LIST_COMMAND = "codex.cli.sessions.list";
export const CODEX_CLI_SESSION_RESUME_COMMAND = "codex.cli.session.resume";

const DEFAULT_SESSION_LIMIT = 10;
const MAX_SESSION_LIMIT = 50;
const DEFAULT_RESUME_TIMEOUT_MS = 20 * 60_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/**
 * The head window carries `session_meta` (id + cwd) and the opening messages. Real rollouts embed
 * the whole instruction set in `session_meta`; the largest observed here is ~149 KiB, so this keeps
 * roughly 3x headroom over that record alone.
 */
const SESSION_FILE_HEAD_SCAN_BYTES = 512 * 1024;
/** Escalation for a `session_meta` record too large to fit the head window, so cwd never drops. */
const SESSION_FILE_HEAD_SCAN_MAX_BYTES = 4 * 1024 * 1024;
/** The tail window supplies the final record `timestamp` and any late user message. */
const SESSION_FILE_TAIL_SCAN_BYTES = 256 * 1024;
/** Below this size head+tail would already cover the file, so read it once and keep counts exact. */
const SESSION_FILE_FULL_READ_BYTES = SESSION_FILE_HEAD_SCAN_BYTES + SESSION_FILE_TAIL_SCAN_BYTES;
/** Rollouts scanned past `limit` to absorb mtime vs. record-`timestamp` ordering skew. */
const SESSION_FILE_SCAN_HEADROOM = 20;
/** A filter can match hydrated fields, so filtered listings scan deeper — but still bounded. */
const FILTERED_SESSION_FILE_SCAN_CAP = 200;
const activeResumeSessions = new Set<string>();

type CodexCliSessionSummary = {
  sessionId: string;
  updatedAt?: string;
  lastMessage?: string;
  cwd?: string;
  sessionFile?: string;
  messageCount: number;
  /**
   * Set when the rollout was too large to read whole: `messageCount` counts only the scanned
   * head/tail windows, and `lastMessage` is the last user message inside them rather than
   * necessarily the last one in the file.
   */
  partialScan?: boolean;
};

type CodexCliSessionFile = {
  file: string;
  basename: string;
  mtimeMs: number;
  size: number;
};

type CodexCliSessionsListResult = {
  sessions: CodexCliSessionSummary[];
  codexHome: string;
};

type CodexCliSessionResumeResult = {
  ok: true;
  sessionId: string;
  text: string;
};

type CodexCliSessionNodeInfo = {
  nodeId?: string;
  displayName?: string;
  remoteIp?: string;
  connected?: boolean;
  commands?: string[];
};

export function createCodexCliSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  return [
    {
      command: CODEX_CLI_SESSIONS_LIST_COMMAND,
      cap: "codex-cli-sessions",
      handle: listLocalCodexCliSessions,
    },
    {
      command: CODEX_CLI_SESSION_RESUME_COMMAND,
      cap: "codex-cli-sessions",
      dangerous: true,
      handle: resumeLocalCodexCliSession,
    },
  ];
}

export function createCodexCliSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [CODEX_CLI_SESSIONS_LIST_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (ctx) => ctx.invokeNode(),
    },
    {
      commands: [CODEX_CLI_SESSION_RESUME_COMMAND],
      dangerous: true,
      handle: (ctx) => ctx.invokeNode(),
    },
  ];
}

export async function listCodexCliSessionsOnNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
  filter?: string;
  limit?: number;
}): Promise<{ node: CodexCliSessionNodeInfo; result: CodexCliSessionsListResult }> {
  const node = await resolveCodexCliNode({
    runtime: params.runtime,
    requestedNode: params.requestedNode,
    command: CODEX_CLI_SESSIONS_LIST_COMMAND,
  });
  const raw = await params.runtime.nodes.invoke({
    nodeId: readNodeId(node),
    command: CODEX_CLI_SESSIONS_LIST_COMMAND,
    params: {
      limit: params.limit,
      filter: params.filter,
    },
    timeoutMs: 15_000,
    scopes: ["operator.write"],
  });
  return { node, result: parseCodexCliSessionsListResult(raw) };
}

export async function resolveCodexCliSessionForBindingOnNode(params: {
  runtime: PluginRuntime;
  requestedNode: string;
  sessionId: string;
}): Promise<{ node: CodexCliSessionNodeInfo; session?: CodexCliSessionSummary }> {
  const listing = await listCodexCliSessionsOnNode({
    runtime: params.runtime,
    requestedNode: params.requestedNode,
    filter: params.sessionId,
    limit: MAX_SESSION_LIMIT,
  });
  if (!listing.node.commands?.includes(CODEX_CLI_SESSION_RESUME_COMMAND)) {
    throw new Error(
      `Node ${formatNodeLabel(listing.node)} does not expose ${CODEX_CLI_SESSION_RESUME_COMMAND}.`,
    );
  }
  return {
    node: listing.node,
    session: listing.result.sessions.find((session) => session.sessionId === params.sessionId),
  };
}

export async function resumeCodexCliSessionOnNode(params: {
  runtime: PluginRuntime;
  nodeId: string;
  sessionId: string;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<CodexCliSessionResumeResult> {
  const raw = await params.runtime.nodes.invoke({
    nodeId: params.nodeId,
    command: CODEX_CLI_SESSION_RESUME_COMMAND,
    params: {
      sessionId: params.sessionId,
      prompt: params.prompt,
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
    },
    timeoutMs: (params.timeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS) + 5_000,
    scopes: ["operator.write"],
  });
  const payload = unwrapNodeInvokePayload(raw);
  if (!isRecord(payload) || payload.ok !== true || typeof payload.text !== "string") {
    throw new Error("Codex CLI resume returned an invalid payload.");
  }
  return {
    ok: true,
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : params.sessionId,
    text: payload.text,
  };
}

export function formatCodexCliSessions(params: {
  node: CodexCliSessionNodeInfo;
  result: CodexCliSessionsListResult;
}): string {
  if (params.result.sessions.length === 0) {
    return `No Codex CLI sessions returned from ${formatCodexDisplayText(formatNodeLabel(params.node))}.`;
  }
  return [
    `Codex CLI sessions on ${formatCodexDisplayText(formatNodeLabel(params.node))}:`,
    ...params.result.sessions.map((session) => {
      const details = [session.cwd, session.updatedAt].filter((value): value is string =>
        Boolean(value),
      );
      return `- ${formatCodexDisplayText(session.sessionId)}${
        session.lastMessage ? ` - ${formatCodexDisplayText(session.lastMessage)}` : ""
      }${details.length > 0 ? ` (${details.map(formatCodexDisplayText).join(", ")})` : ""}\n  Bind: /codex resume ${formatCodexDisplayText(
        session.sessionId,
      )} --host ${formatCodexDisplayText(readNodeId(params.node))} --bind here`;
    }),
  ].join("\n");
}

async function listLocalCodexCliSessions(paramsJSON?: string | null): Promise<string> {
  const params = readRecordParam(paramsJSON);
  const limit = normalizeLimit(params.limit);
  const filter = typeof params.filter === "string" ? params.filter.trim().toLowerCase() : "";
  const codexHome = resolveCodexHome();
  const summaries = await readHistorySessions(codexHome);
  const sessionFiles = await findSessionFiles(path.join(codexHome, "sessions"), 4);
  await hydrateSessionFiles(summaries, sessionFiles);
  await hydrateSessionsFromSessionFiles(
    summaries,
    selectSessionFilesToScan(sessionFiles, filter, limit),
  );
  const sessions = [...summaries.values()]
    .filter((session) => {
      if (!filter) {
        return true;
      }
      return [session.sessionId, session.cwd, session.lastMessage].some((value) =>
        value?.toLowerCase().includes(filter),
      );
    })
    .toSorted((a, b) => compareOptionalStringsDesc(a.updatedAt, b.updatedAt))
    .slice(0, limit);
  return JSON.stringify({ sessions, codexHome } satisfies CodexCliSessionsListResult);
}

async function resumeLocalCodexCliSession(paramsJSON?: string | null): Promise<string> {
  const params = readRecordParam(paramsJSON);
  const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Missing or invalid Codex CLI session id.");
  }
  if (!prompt) {
    throw new Error("Missing Codex CLI prompt.");
  }
  if (activeResumeSessions.has(sessionId)) {
    throw new Error(`Codex CLI session ${sessionId} already has an active resume turn.`);
  }
  activeResumeSessions.add(sessionId);
  try {
    const text = await runCodexExecResume({
      sessionId,
      prompt,
      cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined,
      timeoutMs: normalizeTimeoutMs(params.timeoutMs),
    });
    return JSON.stringify({
      ok: true,
      sessionId,
      text: text.trim() || "Codex completed without a text reply.",
    } satisfies CodexCliSessionResumeResult);
  } finally {
    activeResumeSessions.delete(sessionId);
  }
}

async function runCodexExecResume(params: {
  sessionId: string;
  prompt: string;
  cwd?: string;
  timeoutMs: number;
}): Promise<string> {
  const outputPath = path.join(
    await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-codex-cli-")),
    "last-message.txt",
  );
  try {
    const args = [
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
      params.sessionId,
      "-",
    ];
    const invocation = materializeWindowsSpawnProgram(
      resolveWindowsSpawnProgram({
        command: "codex",
        platform: process.platform,
        env: process.env,
        execPath: process.execPath,
        packageName: "@openai/codex",
      }),
      args,
    );
    const result = await runCommandBuffered([invocation.command, ...invocation.argv], {
      cwd: params.cwd || process.cwd(),
      input: params.prompt,
      env: process.env,
      killGraceMs: 2_000,
      killProcessTree: false,
      terminateOnOutputError: true,
      timeoutMs: params.timeoutMs,
    });
    if (result.termination === "timeout") {
      throw new Error(`codex exec resume timed out after ${String(params.timeoutMs)}ms`);
    }
    if (result.termination === "error" && result.error) {
      throw result.error;
    }
    if (result.code !== 0) {
      const message =
        result.stderr.toString("utf8").trim() ||
        result.stdout.toString("utf8").trim() ||
        `codex exec resume exited with code ${String(result.code)}`;
      throw new Error(message);
    }
    return await fs.readFile(outputPath, "utf8");
  } finally {
    await fs.rm(path.dirname(outputPath), { recursive: true, force: true });
  }
}

async function readHistorySessions(
  codexHome: string,
): Promise<Map<string, CodexCliSessionSummary>> {
  const summaries = new Map<string, CodexCliSessionSummary>();
  const historyPath = path.join(codexHome, "history.jsonl");
  const result = await visitJsonlLines(historyPath, (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.session_id !== "string") {
      return;
    }
    const sessionId = parsed.session_id.trim();
    if (!sessionId) {
      return;
    }
    const entry = summaries.get(sessionId) ?? {
      sessionId,
      messageCount: 0,
    };
    entry.messageCount += 1;
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      entry.lastMessage = truncateText(parsed.text.trim(), 140);
    }
    if (typeof parsed.ts === "number") {
      entry.updatedAt = timestampMsToIsoString(parsed.ts * 1000) ?? entry.updatedAt;
    }
    summaries.set(sessionId, entry);
  });
  if (!result.ok) {
    return new Map();
  }
  return summaries;
}

async function hydrateSessionFiles(
  summaries: Map<string, CodexCliSessionSummary>,
  files: CodexCliSessionFile[],
): Promise<void> {
  if (summaries.size === 0) {
    return;
  }
  const pending = new Set(summaries.keys());
  for (const file of files) {
    const sessionId = [...pending].find((id) => file.basename.includes(id));
    if (!sessionId) {
      continue;
    }
    const entry = summaries.get(sessionId);
    if (!entry) {
      continue;
    }
    entry.sessionFile = file.file;
    const firstLine = (await readFirstLine(file.file)) ?? "";
    const cwd = readSessionMetaCwd(firstLine);
    if (cwd) {
      entry.cwd = cwd;
    }
    pending.delete(sessionId);
    if (pending.size === 0) {
      return;
    }
  }
}

/**
 * Pick the rollouts worth hydrating. The listing is sorted newest-first and sliced to `limit`, so
 * scanning every rollout only to discard all but a handful makes list cost scale with total bytes
 * on disk. Rollouts are append-only, so mtime orders them the same way their last record
 * `timestamp` does; a filter that names a session matches its filename, which keeps resume/binding
 * lookups reachable no matter how old the session is.
 */
function selectSessionFilesToScan(
  files: CodexCliSessionFile[],
  filter: string,
  limit: number,
): CodexCliSessionFile[] {
  const byRecency = files.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  if (!filter) {
    return byRecency.slice(0, limit + SESSION_FILE_SCAN_HEADROOM);
  }
  const named = byRecency.filter((entry) => entry.basename.toLowerCase().includes(filter));
  const rest = byRecency.filter((entry) => !entry.basename.toLowerCase().includes(filter));
  return [...named, ...rest].slice(0, FILTERED_SESSION_FILE_SCAN_CAP);
}

async function hydrateSessionsFromSessionFiles(
  summaries: Map<string, CodexCliSessionSummary>,
  files: CodexCliSessionFile[],
): Promise<void> {
  for (const file of files) {
    const summary = await readSessionFileSummary(file);
    if (!summary) {
      continue;
    }
    const existing = summaries.get(summary.sessionId);
    // `messageCount` and its partial marker describe one scan, so take both from the same source.
    const counted = existing ?? summary;
    summaries.set(summary.sessionId, {
      ...summary,
      ...existing,
      cwd: existing?.cwd ?? summary.cwd,
      sessionFile: existing?.sessionFile ?? summary.sessionFile,
      updatedAt: existing?.updatedAt ?? summary.updatedAt,
      lastMessage: existing?.lastMessage ?? summary.lastMessage,
      messageCount: counted.messageCount,
      partialScan: counted.partialScan,
    });
  }
}

async function readSessionFileSummary(
  file: CodexCliSessionFile,
): Promise<CodexCliSessionSummary | null> {
  const wholeFile = file.size <= SESSION_FILE_FULL_READ_BYTES;
  let head = await readJsonlHead(
    file.file,
    wholeFile ? SESSION_FILE_FULL_READ_BYTES : SESSION_FILE_HEAD_SCAN_BYTES,
  );
  if (head && head.lines.length === 0 && !head.complete) {
    // The first record did not fit the window, so `session_meta` — and with it cwd — is missing.
    head = await readJsonlHead(file.file, SESSION_FILE_HEAD_SCAN_MAX_BYTES);
  }
  if (!head) {
    return null;
  }
  const tail = wholeFile ? null : await readJsonlTail(file.file, SESSION_FILE_TAIL_SCAN_BYTES);
  if (!wholeFile && !tail) {
    return null;
  }
  const lines = tail ? [...head.lines, ...tail.lines] : head.lines;
  if (lines.length === 0) {
    return null;
  }
  const scan = scanSessionFileLines(lines);
  const sessionId = scan.sessionId || readSessionIdFromFilename(file.file) || "";
  if (!sessionId) {
    return null;
  }
  return {
    sessionId,
    updatedAt: scan.updatedAt ?? new Date(file.mtimeMs).toISOString(),
    lastMessage: scan.lastMessage,
    cwd: scan.cwd,
    sessionFile: file.file,
    messageCount: scan.messageCount,
    partialScan: head.complete ? undefined : true,
  };
}

type CodexCliSessionFileScan = {
  sessionId: string;
  cwd?: string;
  updatedAt?: string;
  lastMessage?: string;
  messageCount: number;
};

function scanSessionFileLines(lines: string[]): CodexCliSessionFileScan {
  const scan: CodexCliSessionFileScan = { sessionId: "", messageCount: 0 };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    if (typeof parsed.timestamp === "string" && parsed.timestamp.trim()) {
      scan.updatedAt = parsed.timestamp.trim();
    }
    if (parsed.type === "session_meta" && isRecord(parsed.payload)) {
      if (typeof parsed.payload.id === "string" && parsed.payload.id.trim()) {
        scan.sessionId = parsed.payload.id.trim();
      }
      if (typeof parsed.payload.cwd === "string" && parsed.payload.cwd.trim()) {
        scan.cwd = parsed.payload.cwd.trim();
      }
      continue;
    }
    const messageText = readResponseItemMessageText(parsed);
    if (messageText) {
      scan.messageCount += 1;
      scan.lastMessage = truncateText(messageText, 140);
    }
  }
  return scan;
}

async function findSessionFiles(dir: string, maxDepth: number): Promise<CodexCliSessionFile[]> {
  if (maxDepth < 0) {
    return [];
  }
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: CodexCliSessionFile[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findSessionFiles(entryPath, maxDepth - 1)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    // Ordering and read-window selection both need size/mtime, so stat once here instead of
    // opening every rollout to find out how recent it is.
    const stats = await fs.stat(entryPath).catch(() => undefined);
    if (!stats) {
      continue;
    }
    files.push({
      file: entryPath,
      basename: entry.name,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    });
  }
  return files;
}

function readSessionMetaCwd(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || parsed.type !== "session_meta" || !isRecord(parsed.payload)) {
      return undefined;
    }
    return typeof parsed.payload.cwd === "string" && parsed.payload.cwd.trim()
      ? parsed.payload.cwd.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function readResponseItemMessageText(parsed: Record<string, unknown>): string | undefined {
  if (parsed.type !== "response_item" || !isRecord(parsed.payload)) {
    return undefined;
  }
  if (parsed.payload.type !== "message") {
    return undefined;
  }
  const role = typeof parsed.payload.role === "string" ? parsed.payload.role : "";
  if (role !== "user") {
    return undefined;
  }
  const content = Array.isArray(parsed.payload.content) ? parsed.payload.content : [];
  const parts = content.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const text =
      typeof entry.text === "string"
        ? entry.text
        : typeof entry.input_text === "string"
          ? entry.input_text
          : undefined;
    return text?.trim() ? [text.trim()] : [];
  });
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function readSessionIdFromFilename(file: string): string | undefined {
  const match = path.basename(file).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
  return match?.[0];
}

async function resolveCodexCliNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
  command: string;
}): Promise<CodexCliSessionNodeInfo> {
  const list = await params.runtime.nodes.list(
    params.requestedNode ? undefined : { connected: true },
  );
  const requested = params.requestedNode?.trim();
  const candidates = list.nodes.filter((node) => {
    if (requested) {
      return [node.nodeId, node.displayName, node.remoteIp].some((value) => value === requested);
    }
    return node.connected === true && node.commands?.includes(params.command);
  });
  if (candidates.length === 0) {
    throw new Error(
      requested
        ? `Codex CLI node ${requested} was not found.`
        : "No connected node exposes Codex CLI session commands.",
    );
  }
  const usable = candidates.filter((node) => node.commands?.includes(params.command));
  if (usable.length === 0) {
    throw new Error(`Node ${requested ?? "candidate"} does not expose ${params.command}.`);
  }
  if (usable.length > 1) {
    throw new Error("Multiple Codex CLI-capable nodes connected. Pass --host <node-id>.");
  }
  return expectDefined(usable[0], "single usable Codex CLI node");
}

function parseCodexCliSessionsListResult(raw: unknown): CodexCliSessionsListResult {
  const payload = unwrapNodeInvokePayload(raw);
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
    throw new Error("Codex CLI session list returned an invalid payload.");
  }
  return {
    codexHome: typeof payload.codexHome === "string" ? payload.codexHome : "",
    sessions: payload.sessions.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.sessionId !== "string") {
        return [];
      }
      return [
        {
          sessionId: entry.sessionId,
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
          lastMessage: typeof entry.lastMessage === "string" ? entry.lastMessage : undefined,
          cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
          sessionFile: typeof entry.sessionFile === "string" ? entry.sessionFile : undefined,
          messageCount:
            typeof entry.messageCount === "number" && Number.isFinite(entry.messageCount)
              ? entry.messageCount
              : 0,
          partialScan: entry.partialScan === true ? true : undefined,
        },
      ];
    }),
  };
}

function unwrapNodeInvokePayload(raw: unknown): unknown {
  const record = isRecord(raw) ? raw : {};
  if (typeof record.payloadJSON === "string" && record.payloadJSON.trim()) {
    try {
      return JSON.parse(record.payloadJSON) as unknown;
    } catch (error) {
      throw new Error("Codex CLI node command returned malformed payloadJSON.", {
        cause: error,
      });
    }
  }
  if ("payload" in record) {
    return record.payload;
  }
  return raw;
}

function readRecordParam(paramsJSON?: string | null): Record<string, unknown> {
  if (!paramsJSON?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(paramsJSON) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

async function readFirstLine(file: string): Promise<string | undefined> {
  const head = await readJsonlHead(file, SESSION_FILE_HEAD_SCAN_BYTES);
  return head?.lines[0];
}

function normalizeLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_SESSION_LIMIT, Math.max(1, Math.floor(value)))
    : DEFAULT_SESSION_LIMIT;
}

function normalizeTimeoutMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(60 * 60_000, Math.floor(value))
    : DEFAULT_RESUME_TIMEOUT_MS;
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${truncateUtf16Safe(value, Math.max(0, max - 3))}...`;
}

function compareOptionalStringsDesc(a?: string, b?: string): number {
  return (b ?? "").localeCompare(a ?? "");
}

function readNodeId(node: CodexCliSessionNodeInfo): string {
  if (!node.nodeId) {
    throw new Error("Codex CLI node did not include a node id.");
  }
  return node.nodeId;
}

function formatNodeLabel(node: CodexCliSessionNodeInfo): string {
  return [node.displayName, node.nodeId, node.remoteIp].filter(Boolean).join(" / ") || "node";
}
