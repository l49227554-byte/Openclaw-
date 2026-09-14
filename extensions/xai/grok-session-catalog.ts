import { existsSync, lstatSync, statSync } from "node:fs";
import {
  lstat as lstatAsync,
  readdir as readdirAsync,
  readFile as readFileAsync,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type {
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "openclaw/plugin-sdk/session-catalog";
import { sessionCatalogPaging } from "openclaw/plugin-sdk/session-catalog";
import {
  isRecord,
  normalizeBoundedOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const LOCAL_HOST_ID = "gateway";
const MAX_SEARCH_LENGTH = 500;
const MAX_SESSION_GROUPS = 2_000;
const MAX_SESSIONS = 10_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

type GrokSessionPage = { sessions: SessionCatalogSession[]; nextCursor?: string };

type GrokSessionFile = {
  directory: string;
  threadId: string;
};

export const isExactGrokSessionCursor = sessionCatalogPaging.isExactCursor;

const GROK_PARAMETER_MESSAGES = {
  listNotObject: "Grok Build session list parameters must be an object",
  unknownListParameter: (key: string) => `unknown Grok Build session list parameter: ${key}`,
  invalidSearchTerm: "searchTerm is invalid",
  readNotObject: "Grok Build session read parameters must be an object",
  unknownReadParameter: (key: string) => `unknown Grok Build session read parameter: ${key}`,
  invalidThreadId: "threadId is invalid",
};

function grokHome(env: NodeJS.ProcessEnv): { root: string; usesProcessHomeFallback: boolean } {
  const configured = env.GROK_HOME?.trim();
  if (configured) {
    return { root: path.resolve(configured), usesProcessHomeFallback: false };
  }
  const home = (process.platform === "win32" ? env.USERPROFILE : env.HOME)?.trim() || os.homedir();
  return { root: path.join(home, ".grok"), usesProcessHomeFallback: true };
}

function grokSessionRoot(env: NodeJS.ProcessEnv): string {
  return path.join(grokHome(env).root, "sessions");
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    const stats = await lstatAsync(candidate);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFileAsync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseSummary(file: GrokSessionFile, value: unknown): SessionCatalogSession | undefined {
  if (!isRecord(value) || !isRecord(value.info)) {
    return undefined;
  }
  const threadId = normalizeBoundedOptionalString(value.info.id, 128);
  if (!threadId || threadId !== file.threadId || !SESSION_ID_PATTERN.test(threadId)) {
    return undefined;
  }
  const name =
    normalizeBoundedOptionalString(value.generated_title, 1_000) ??
    normalizeBoundedOptionalString(value.session_summary, 1_000);
  const cwd = normalizeBoundedOptionalString(value.info.cwd, 4_096);
  const createdAt = timestampMs(value.created_at);
  const updatedAt = timestampMs(value.last_active_at) ?? timestampMs(value.updated_at);
  const model = normalizeBoundedOptionalString(value.current_model_id, 256);
  const gitBranch = normalizeBoundedOptionalString(value.head_branch, 256);
  return {
    threadId,
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
    status: "stored",
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt, recencyAt: updatedAt } : {}),
    source: "grok-build-local",
    ...(model ? { modelProvider: "xai" } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    archived: false,
    canContinue: false,
    canArchive: false,
    canOpenTerminal: false,
  };
}

async function listSessionFiles(): Promise<GrokSessionFile[]> {
  const root = grokSessionRoot(process.env);
  if (!(await isDirectory(root))) {
    return [];
  }
  const groups = (await readdirAsync(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .slice(0, MAX_SESSION_GROUPS);
  const sessions: GrokSessionFile[] = [];
  for (const group of groups) {
    const directory = path.join(root, group.name);
    const entries = await readdirAsync(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SESSION_ID_PATTERN.test(entry.name)) {
        continue;
      }
      sessions.push({ directory: path.join(directory, entry.name), threadId: entry.name });
      if (sessions.length >= MAX_SESSIONS) {
        return sessions;
      }
    }
  }
  return sessions;
}

async function findSession(threadId: string): Promise<GrokSessionFile | undefined> {
  return (await listSessionFiles()).find((session) => session.threadId === threadId);
}

export async function listLocalGrokSessionPage(value?: unknown): Promise<GrokSessionPage> {
  const params = sessionCatalogPaging.parseListParams(value, {
    searchMaxLength: MAX_SEARCH_LENGTH,
    messages: GROK_PARAMETER_MESSAGES,
  });
  const offset = sessionCatalogPaging.decodeCursor(params.cursor);
  const needle = params.searchTerm?.toLocaleLowerCase();
  const sessions = (
    await Promise.all(
      (await listSessionFiles()).map(async (file) =>
        parseSummary(file, await readJson(path.join(file.directory, "summary.json"))),
      ),
    )
  )
    .flatMap((session) => (session ? [session] : []))
    .filter(
      (session) =>
        !needle ||
        [session.threadId, session.name, session.cwd, session.gitBranch].some((field) =>
          field?.toLocaleLowerCase().includes(needle),
        ),
    )
    .sort((left, right) => (right.recencyAt ?? 0) - (left.recencyAt ?? 0));
  const page = sessions.slice(offset, offset + params.limit);
  return {
    sessions: page,
    ...(offset + page.length < sessions.length
      ? { nextCursor: sessionCatalogPaging.encodeCursor(offset + page.length) }
      : {}),
  };
}

function transcriptText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
  return text || undefined;
}

function transcriptItems(value: unknown): SessionCatalogTranscriptItem[] {
  if (!isRecord(value)) {
    return [];
  }
  const type = normalizeBoundedOptionalString(value.type, 128);
  if (type === "system") {
    return [];
  }
  const text =
    transcriptText(value.content) ?? normalizeBoundedOptionalString(value.summary, 20_000);
  if (!type || !text) {
    return [];
  }
  if (type === "user") {
    return [{ type: "userMessage", text }];
  }
  if (type === "assistant") {
    return [{ type: "agentMessage", text }];
  }
  if (type === "reasoning") {
    return [{ type: "reasoning", text }];
  }
  return [{ type: "other", text }];
}

export async function readLocalGrokTranscriptPage(
  value: unknown,
): Promise<SessionsCatalogReadResult> {
  const params = sessionCatalogPaging.parseReadParams(value, {
    threadIdMaxLength: 128,
    threadIdPattern: SESSION_ID_PATTERN,
    messages: GROK_PARAMETER_MESSAGES,
  });
  const session = await findSession(params.threadId);
  if (!session) {
    throw new Error("Grok Build session is unavailable");
  }
  const content = await readFileAsync(
    path.join(session.directory, "chat_history.jsonl"),
    "utf8",
  ).catch(() => "");
  const items = content
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return transcriptItems(JSON.parse(line) as unknown);
      } catch {
        return [];
      }
    });
  const page = sessionCatalogPaging.boundTranscriptPage(
    items,
    params.limit,
    sessionCatalogPaging.decodeCursor(params.cursor),
  );
  return { hostId: LOCAL_HOST_ID, label: "Local Grok Build", threadId: params.threadId, ...page };
}

export function grokSessionStoreAvailable(env: NodeJS.ProcessEnv): boolean {
  const root = grokSessionRoot(env);
  try {
    return existsSync(root) && statSync(root).isDirectory() && !lstatSync(root).isSymbolicLink();
  } catch {
    return false;
  }
}

export function grokUsesProcessHomeFallback(env: NodeJS.ProcessEnv): boolean {
  return grokHome(env).usesProcessHomeFallback;
}
