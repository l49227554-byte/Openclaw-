/**
 * Real runtime proof for openclaw/openclaw#147040: a loopback Anthropic-format provider
 * first completes a valid `write` tool call (a committed side effect), then completes a
 * tool call whose argument buffer is truncated. The transport rejects that call before
 * dispatch. The original-prompt resubmit is closed by the committed write, so the
 * embedded runner continues the current transcript and recovers with the provider's
 * third, well-formed response, without replaying the prompt or the write.
 */
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const PROVIDER_ID = "mock-anthropic";
const MODEL_ID = "claude-opus-5";
const USER_PROMPT = "write my note, then update the config";
// Alphanumeric like a real Anthropic id; the runner normalizes ids before replay.
const WRITE_CALL_ID = "toolu01issue147040write";
const WRITE_CONTENT = "ISSUE147040_WRITE_DONE\n";
const TRUNCATED_FRAGMENT = '{"path":"config.json","old_string":"{\\n  \\"port';
const RECOVERED_MARKER = "ISSUE147040_RECOVERED_AFTER_REJECTION";
const TOKEN = "issue147040-proof-token";

type CapturedRequest = {
  method: string;
  url: string;
  stream: unknown;
  messages: unknown[];
};

function anthropicSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function messageStart(id: string): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: MODEL_ID,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 640, output_tokens: 0 },
    },
  };
}

function toolUseTurn(params: {
  id: string;
  callId: string;
  name: string;
  partialJson: string;
}): string {
  return anthropicSse([
    messageStart(params.id),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: params.callId, name: params.name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: params.partialJson },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1329 },
    },
    { type: "message_stop" },
  ]);
}

/** Request 1: a valid `write` call that the runner executes (committed side effect). */
function writeToolTurn(): string {
  return toolUseTurn({
    id: "msg_issue147040_write",
    callId: WRITE_CALL_ID,
    name: "write",
    partialJson: JSON.stringify({ path: "note.txt", content: WRITE_CONTENT }),
  });
}

/** Request 2: a sealed `edit` call whose argument buffer is truncated mid-string. */
function rejectedToolCallTurn(): string {
  return toolUseTurn({
    id: "msg_issue147040_rejected",
    callId: "call_issue147040_truncated",
    name: "edit",
    partialJson: TRUNCATED_FRAGMENT,
  });
}

/** Request 3: a plain text answer carrying the recovery marker. */
function recoveredTextTurn(): string {
  return anthropicSse([
    messageStart("msg_issue147040_recovered"),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: RECOVERED_MARKER },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
    },
    { type: "message_stop" },
  ]);
}

function buildMockAnthropicProvider(baseUrl: string) {
  const model: ModelDefinitionConfig = {
    id: MODEL_ID,
    name: "Mock Claude Opus 5",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  const config: Omit<ModelProviderConfig, "models"> & { models: [ModelDefinitionConfig] } = {
    baseUrl,
    apiKey: "sk-ant-api03-issue147040-proof", // pragma: allowlist secret
    api: "anthropic-messages",
    models: [model],
  };
  return { providerId: PROVIDER_ID, modelRef: `${PROVIDER_ID}/${MODEL_ID}`, config } as const;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("issue #147040 real runtime proof", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "continues the transcript after a tool-call rejection that follows a committed write",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const providerRequests: CapturedRequest[] = [];

      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-issue147040-proof-"));
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: TOKEN,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }

        providerServer = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            const parsed = JSON.parse(body) as { stream?: unknown; messages?: unknown[] };
            providerRequests.push({
              method: request.method ?? "",
              url: request.url ?? "",
              stream: parsed.stream,
              messages: parsed.messages ?? [],
            });
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            });
            // 1: valid write (executed), 2: truncated call (rejected), 3+: recovery text.
            const turn = providerRequests.length;
            response.end(
              turn === 1
                ? writeToolTurn()
                : turn === 2
                  ? rejectedToolCallTurn()
                  : recoveredTextTurn(),
            );
          });
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockAnthropicProvider(`http://127.0.0.1:${providerAddress.port}`);
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
            },
            entries: { main: { default: true } },
          },
          tools: { profile: "coding" },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };
        const sessionKey = "agent:main:issue147040-proof";
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: TOKEN,
          clientDisplayName: "issue147040-proof",
        });
        const started = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey,
            message: USER_PROMPT,
            deliver: false,
            idempotencyKey: "issue147040-proof-turn",
          },
        );
        expect(started.status).toBe("started");
        const waited = await gateway.client.request<{ status?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
        expect(waited).toMatchObject({ status: "ok" });

        // The committed side effect happened exactly once: the write ran, and the
        // recovery did not replay the prompt or re-run the tool.
        await expect(fs.readFile(path.join(workspaceDir, "note.txt"), "utf8")).resolves.toBe(
          WRITE_CONTENT,
        );

        // Three streaming Messages requests went to the real transport over HTTP:
        // the prompt, the post-write continuation, and the post-rejection continuation.
        expect(
          providerRequests.map(({ method, url, stream }) => ({ method, url, stream })),
        ).toEqual([
          { method: "POST", url: "/v1/messages", stream: true },
          { method: "POST", url: "/v1/messages", stream: true },
          { method: "POST", url: "/v1/messages", stream: true },
        ]);
        // The recovery request continued the current transcript: the settled write
        // result is still there, the prompt appears once, and nothing from the
        // rejected call reached the provider.
        const recoveryMessages = JSON.stringify(providerRequests[2]?.messages ?? []);
        expect(recoveryMessages).toContain(`"tool_use_id":"${WRITE_CALL_ID}"`);
        expect(recoveryMessages).toContain('"name":"write"');
        expect(recoveryMessages).toContain("Successfully wrote");
        expect(countOccurrences(recoveryMessages, USER_PROMPT)).toBe(1);
        expect(recoveryMessages).not.toContain(TRUNCATED_FRAGMENT);
        expect(recoveryMessages).not.toContain("malformed JSON arguments");

        const history = await gateway.client.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey,
          limit: 20,
        });
        const serialized = JSON.stringify(history.messages ?? []);
        expect(serialized).toContain(RECOVERED_MARKER);
        expect(serialized).not.toContain("malformed JSON arguments");
        expect(serialized).not.toContain(TRUNCATED_FRAGMENT);
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
