import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGrokSessionCatalogRuntime } from "./grok-session-catalog-registration.js";
import { listLocalGrokSessionPage, readLocalGrokTranscriptPage } from "./grok-session-catalog.js";

const SESSION_ID = "019fba9a-2475-72f3-b624-3ab86cc20be5";
let grokHome: string;

async function createSession(): Promise<void> {
  const directory = path.join(grokHome, "sessions", "workspace", SESSION_ID);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "summary.json"),
    JSON.stringify({
      info: { id: SESSION_ID, cwd: "/tmp/shadowiq" },
      generated_title: "Audit trip alerts",
      created_at: "2026-09-14T06:00:00.000Z",
      updated_at: "2026-09-14T07:00:00.000Z",
      current_model_id: "grok-4.6",
      head_branch: "main",
    }),
  );
  await writeFile(
    path.join(directory, "chat_history.jsonl"),
    [
      JSON.stringify({ type: "system", content: "ignored" }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "Audit this trip" }] }),
      JSON.stringify({ type: "assistant", content: "Here is the result" }),
    ].join("\n"),
  );
}

beforeEach(async () => {
  grokHome = await mkdtemp(path.join(os.tmpdir(), "grok-session-catalog-"));
  vi.stubEnv("GROK_HOME", grokHome);
  await createSession();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(grokHome, { recursive: true, force: true });
});

describe("Grok Build session catalog", () => {
  it("lists local sessions from Grok's documented summary files", async () => {
    const page = await listLocalGrokSessionPage({ limit: 10 });
    expect(page.sessions).toEqual([
      expect.objectContaining({
        threadId: SESSION_ID,
        name: "Audit trip alerts",
        cwd: "/tmp/shadowiq",
        modelProvider: "xai",
        canContinue: false,
        canArchive: false,
        canOpenTerminal: false,
      }),
    ]);
  });

  it("projects user and assistant messages without exposing system prompts", async () => {
    const transcript = await readLocalGrokTranscriptPage({ threadId: SESSION_ID, limit: 10 });
    expect(transcript.items).toEqual([
      { type: "agentMessage", text: "Here is the result" },
      { type: "userMessage", text: "Audit this trip" },
    ]);
  });

  it("exposes the local store as a read-only Gateway catalog", async () => {
    const catalog = createGrokSessionCatalogRuntime();
    const hosts = await catalog.list({});
    expect(hosts).toEqual([
      expect.objectContaining({
        hostId: "gateway",
        kind: "gateway",
        sessions: [expect.objectContaining({ threadId: SESSION_ID, canContinue: false })],
      }),
    ]);
    await expect(catalog.read({ hostId: "node:not-grok", threadId: SESSION_ID })).rejects.toThrow(
      "hostId is invalid",
    );
  });
});
