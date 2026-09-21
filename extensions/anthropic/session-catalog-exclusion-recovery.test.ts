// Covers Desktop and index exclusion recovery plus transcript-lookup boundary
// cases for the Claude session catalog.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CATALOG_JSON_FILE_BYTES } from "./session-catalog-scan.js";
import { listLocalClaudeSessionPage, readLocalClaudeTranscriptPage } from "./session-catalog.js";

const homes: string[] = [];

async function createHome(): Promise<string> {
  // openclaw-temp-dir: allow per-home catalog fixture removed in afterEach
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-catalog-"));
  homes.push(home);
  return home;
}

async function writeProject(params: {
  home: string;
  project?: string;
  entries: Array<Record<string, unknown>>;
  transcripts: Record<string, Array<Record<string, unknown>>>;
}): Promise<void> {
  const projectDir = path.join(params.home, ".claude", "projects", params.project ?? "-workspace");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({ version: 1, entries: params.entries }),
  );
  await Promise.all(
    Object.entries(params.transcripts).map(([sessionId, rows]) =>
      fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      ),
    ),
  );
}

async function writeDesktopMetadata(
  home: string,
  name: string,
  metadata: Record<string, unknown>,
  _options?: { pretty?: boolean },
): Promise<void> {
  const dir = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
    "account",
    "workspace",
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `local_${name}.json`), JSON.stringify(metadata));
}

async function writeIndexedDesktopSession(
  home: string,
  params: {
    sessionId: string;
    localSessionId: string;
    metadataName: string;
    title: string;
    prompt: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { sessionId, localSessionId, metadataName, title, prompt, metadata } = params;
  await writeProject({
    home,
    entries: [
      {
        sessionId,
        fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
        projectPath: "/work/openclaw",
        isSidechain: false,
      },
    ],
    transcripts: { [sessionId]: [message(sessionId, "user", prompt, 1)] },
  });
  await writeDesktopMetadata(home, metadataName, {
    sessionId: localSessionId,
    cliSessionId: sessionId,
    cwd: "/work/openclaw",
    title,
    ...metadata,
  });
}

function message(
  sessionId: string,
  type: "user" | "assistant",
  text: string | Record<string, unknown>[],
  index: number,
): Record<string, unknown> {
  return {
    type,
    sessionId,
    uuid: `${sessionId}-${index}`,
    timestamp: `2026-07-0${index}T00:00:00.000Z`,
    isSidechain: false,
    message: {
      role: type,
      content: typeof text === "string" ? [{ type: "text", text }] : text,
      ...(type === "assistant" ? { model: "claude-opus-4-8" } : {}),
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("Claude session catalog exclusions and recovery", () => {
  it("preserves Desktop source when active metadata is over the JSON limit", async () => {
    const home = await createHome();
    const sessionId = "desktop-over-limit-source";
    await writeIndexedDesktopSession(home, {
      sessionId,
      localSessionId: "local-desktop-over-limit-source",
      metadataName: "over-limit-source",
      title: "Desktop source",
      prompt: "Desktop source prompt",
      metadata: { padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES) },
    });

    const page = await listLocalClaudeSessionPage({ limit: 100 }, home);
    expect(page).toMatchObject({
      error: { code: "LOCAL_CATALOG_PARTIAL" },
      sessions: [
        expect.objectContaining({
          threadId: sessionId,
          source: "claude-desktop",
        }),
      ],
    });
  });

  it("keeps a specific transcript readable when its index is beyond the scan budget", async () => {
    const home = await createHome();
    const sessionId = "catalog-lookup-beyond-budget";
    const projectDir = path.join(home, ".claude", "projects", "-target");
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    const indexPath = path.join(projectDir, "sessions-index.json");
    await fs.mkdir(projectDir, { recursive: true });
    const entry = {
      sessionId,
      fullPath: transcriptPath,
      summary: "Beyond-budget session",
      isSidechain: false,
    };
    const prefix = `{"version":1,"entries":${JSON.stringify([entry])},"padding":"`;
    const suffix = `"}`;
    const paddingBytes =
      MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    await fs.writeFile(indexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify(message(sessionId, "user", "Readable beyond budget", 1))}\n`,
    );

    await expect(
      listLocalClaudeSessionPage({}, home, { includeDesktop: false }),
    ).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: sessionId, name: "Beyond-budget session" })],
      error: { code: "LOCAL_CATALOG_PARTIAL" },
    });
    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home, {
        includeDesktop: false,
      }),
    ).resolves.toMatchObject({
      threadId: sessionId,
      items: [expect.objectContaining({ type: "userMessage", text: "Readable beyond budget" })],
    });
  });

  it.each([
    {
      name: "sidechain",
      row: {
        ...message("excluded-session", "user", "Sidechain", 1),
        entrypoint: "cli",
        isSidechain: true,
      },
      indexIsSidechain: true,
      indexEntry: true,
      oversizedIndex: false,
    },
    {
      name: "index-only sidechain",
      row: {
        ...message("excluded-session", "user", "Index-only sidechain", 1),
        entrypoint: "cli",
      },
      indexIsSidechain: true,
      indexEntry: true,
      oversizedIndex: true,
    },
    {
      name: "foreign entrypoint",
      row: { ...message("excluded-session", "user", "Foreign", 1), entrypoint: "sdk" },
      indexIsSidechain: false,
      indexEntry: false,
      oversizedIndex: false,
    },
  ])(
    "does not bypass the $name exclusion for a partial transcript lookup",
    async ({ name, row, indexIsSidechain, indexEntry, oversizedIndex }) => {
      const home = await createHome();
      const sessionId = "excluded-session";
      const projectDir = path.join(home, ".claude", "projects", "-excluded");
      const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
      const indexPath = path.join(projectDir, "sessions-index.json");
      await fs.mkdir(projectDir, { recursive: true });
      const entry = {
        sessionId,
        fullPath: transcriptPath,
        isSidechain: indexIsSidechain,
        ...(oversizedIndex ? { firstPrompt: "x".repeat(256 * 1024) } : {}),
      };
      const indexContent = JSON.stringify({ version: 1, entries: indexEntry ? [entry] : [] });
      if (oversizedIndex) {
        const prefix = `{"version":1,"entries":[${JSON.stringify(entry)}],"padding":"`;
        const suffix = `"}`;
        const paddingBytes =
          MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
        await fs.writeFile(indexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
      } else {
        await fs.writeFile(indexPath, indexContent);
      }
      const oversizedProjectDir = path.join(home, ".claude", "projects", "-unrelated");
      const oversizedIndexPath = path.join(oversizedProjectDir, "sessions-index.json");
      await fs.mkdir(oversizedProjectDir, { recursive: true });
      const prefix = `{"version":1,"entries":[],"padding":"`;
      const suffix = `"}`;
      const paddingBytes =
        MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
      await fs.writeFile(oversizedIndexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
      await fs.writeFile(transcriptPath, `${JSON.stringify(row)}\n`);

      if (name === "index-only sidechain") {
        await expect(
          listLocalClaudeSessionPage({}, home, { includeDesktop: false }),
        ).resolves.toMatchObject({
          sessions: [],
          error: { code: "LOCAL_CATALOG_PARTIAL" },
        });
      }
      await expect(
        readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home, {
          includeDesktop: false,
        }),
      ).rejects.toThrow("Claude session is unavailable");
    },
  );

  it("recovers sidechain exclusions when an admitted index grows before its read", async () => {
    const home = await createHome();
    const sessionId = "descriptor-race-sidechain";
    const projectDir = path.join(home, ".claude", "projects", "-descriptor-race");
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    const indexPath = path.join(projectDir, "sessions-index.json");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      indexPath,
      JSON.stringify({
        version: 1,
        entries: [{ sessionId, fullPath: transcriptPath, isSidechain: true }],
      }),
    );
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ sessionId, entrypoint: "cli", type: "user", message: { content: "hidden" } })}\n`,
    );
    const realOpen = fs.open.bind(fs);
    let raced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[0] === indexPath && !raced) {
        raced = true;
        await fs.appendFile(indexPath, " ");
      }
      return handle;
    });

    await expect(
      listLocalClaudeSessionPage({}, home, { includeDesktop: false }),
    ).resolves.toMatchObject({
      sessions: [],
      error: { code: "LOCAL_CATALOG_PARTIAL" },
    });
    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home, {
        includeDesktop: false,
      }),
    ).rejects.toThrow("Claude session is unavailable");
  });

  it("does not bypass a skipped Desktop archive for a partial transcript lookup", async () => {
    const home = await createHome();
    const sessionId = "desktop-archive-partial-lookup";
    const projectDir = path.join(home, ".claude", "projects", "-archived");
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    await writeProject({
      home,
      project: "-archived",
      entries: [{ sessionId, fullPath: transcriptPath, isSidechain: false }],
      transcripts: { [sessionId]: [message(sessionId, "user", "Archived", 1)] },
    });
    await writeDesktopMetadata(home, "archived-partial-lookup", {
      cliSessionId: sessionId,
      isArchived: true,
      padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
    });

    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home),
    ).rejects.toThrow("Claude session is unavailable");
  });

  it("recovers a Desktop archive when metadata grows after admission", async () => {
    const home = await createHome();
    const sessionId = "desktop-archive-descriptor-race";
    const projectDir = path.join(home, ".claude", "projects", "-archived-race");
    const desktopPath = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
      "account",
      "workspace",
      "local_archived-race.json",
    );
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    await writeProject({
      home,
      project: "-archived-race",
      entries: [{ sessionId, fullPath: transcriptPath, isSidechain: false }],
      transcripts: { [sessionId]: [message(sessionId, "user", "Archived", 1)] },
    });
    await writeDesktopMetadata(home, "archived-race", {
      cliSessionId: sessionId,
      isArchived: true,
    });

    const realOpen = fs.open.bind(fs);
    let raced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[0] === desktopPath && !raced) {
        raced = true;
        await fs.appendFile(desktopPath, " ");
      }
      return handle;
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [],
      error: { code: "LOCAL_CATALOG_PARTIAL" },
    });
    expect(raced).toBe(true);
    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home),
    ).rejects.toThrow("Claude session is unavailable");
  });

  it("removes an active duplicate when a skipped Desktop archive is discovered", async () => {
    const home = await createHome();
    const sessionId = "desktop-archive-duplicate";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "CLI duplicate",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "Duplicate", 1)] },
    });
    await writeDesktopMetadata(home, "active", {
      cliSessionId: sessionId,
      title: "Active duplicate",
    });
    await writeDesktopMetadata(home, "archived", {
      cliSessionId: sessionId,
      isArchived: true,
      padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({ sessions: [] });
  });

  it("recognizes archived Desktop metadata when JSON booleans use whitespace delimiters", async () => {
    const home = await createHome();
    const sessionId = "desktop-archive-whitespace";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "CLI duplicate",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "Duplicate", 1)] },
    });
    await writeDesktopMetadata(home, "active", { cliSessionId: sessionId });
    await writeDesktopMetadata(
      home,
      "archived",
      {
        cliSessionId: sessionId,
        padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
        isArchived: true,
      },
      { pretty: true },
    );

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({ sessions: [] });
  });

  it("recognizes archived Desktop metadata after escaped strings", async () => {
    const home = await createHome();
    const sessionId = "desktop-archive-escaped";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "CLI duplicate",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "Duplicate", 1)] },
    });
    await writeDesktopMetadata(home, "active", { cliSessionId: sessionId });
    await writeDesktopMetadata(home, "archived", {
      cliSessionId: sessionId,
      title: 'Archived "title"',
      isArchived: true,
      padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({ sessions: [] });
  });
});
