import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let enabledPort: number;
let enabledServer: Awaited<ReturnType<typeof startGatewayServerWithRetries>>["server"];

beforeAll(async () => {
  const started = await startGatewayServerWithRetries({
    port: await getGatewayTestPort(),
    opts: {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openResponsesEnabled: true,
    },
  });
  enabledPort = started.port;
  enabledServer = started.server;
});

afterAll(async () => {
  await enabledServer?.close({ reason: "openresponses prompt-mode suite done" });
});

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required for gateway config tests");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function ensureResponseConsumed(res: Response) {
  if (res.bodyUsed) {
    return;
  }
  try {
    await res.text();
  } catch {
    // Ignore drain failures; best-effort to release keep-alive sockets in tests.
  }
}

describe("OpenResponses HTTP promptMode", () => {
  it.each([{ stream: false }, { stream: true }])(
    "defers HTTP promptMode to each attempt model's tools profile (stream: $stream)",
    async ({ stream }) => {
      await writeGatewayConfig({
        tools: {
          profile: "minimal",
          byProvider: { openai: { profile: "coding" } },
        },
        agents: { list: [{ id: "main" }] },
      });
      resetConfigRuntimeState();
      try {
        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
        const res = await fetch(`http://127.0.0.1:${enabledPort}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-openclaw-scopes": "operator.write",
          },
          body: JSON.stringify({
            stream,
            model: "openclaw",
            input: "PONG",
          }),
        });
        expect(res.status).toBe(200);
        const opts = agentCommandMock.mock.calls[0]?.[0] as
          | { promptMode?: unknown; promptModeFromToolsProfile?: unknown }
          | undefined;
        expect(opts?.promptMode).toBeUndefined();
        expect(opts?.promptModeFromToolsProfile).toBe(true);
        await ensureResponseConsumed(res);
      } finally {
        await writeGatewayConfig({});
        resetConfigRuntimeState();
      }
    },
  );
});
