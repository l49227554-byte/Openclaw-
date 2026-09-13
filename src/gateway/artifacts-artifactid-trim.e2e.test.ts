import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createManagedOutgoingMediaBlocks } from "./managed-image-attachments.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, testState, withGatewayServer, writeSessionStore } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const GATEWAY_TOKEN = "artifacts-artifactid-trim-e2e-token";
const SESSION_KEY = "agent:main:main";

describe("artifacts.get/download Gateway E2E", () => {
  it("gets and downloads a live transcript artifact when artifactId is padded", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for artifact trim E2E fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: GATEWAY_TOKEN };
    const storePath = path.join(stateDir, "sessions.sqlite");
    testState.sessionStorePath = storePath;

    const source = await fs.readFile(
      path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
    );
    const messageId = "artifacts-artifactid-trim-message";
    const blocks = await createManagedOutgoingMediaBlocks({
      sessionKey: SESSION_KEY,
      messageId,
      items: [
        {
          url: `data:image/png;base64,${source.toString("base64")}`,
          trustedLocal: false,
        },
      ],
      stateDir,
    });
    const block = blocks.find(
      (candidate) => candidate.type === "image" && typeof candidate.artifactId === "string",
    );
    if (!block || typeof block.artifactId !== "string") {
      throw new Error("managed image fixture did not produce an artifact");
    }
    const artifactId = block.artifactId;
    const paddedId = ` ${artifactId} `;
    expect(paddedId).not.toBe(artifactId);

    const sessionId = "artifacts-artifactid-trim-session";
    const transcriptPath = path.join(stateDir, `${sessionId}.jsonl`);
    const timestamp = new Date().toISOString();
    await fs.writeFile(
      transcriptPath,
      `${[
        { type: "session", version: 3, id: sessionId, timestamp, cwd: stateDir },
        {
          type: "message",
          id: messageId,
          parentId: null,
          timestamp,
          message: {
            role: "assistant",
            content: blocks,
            timestamp: Date.now(),
            __openclaw: { id: messageId },
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    await writeSessionStore({
      entries: {
        [SESSION_KEY]: {
          sessionId,
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
    });

    await withGatewayServer(async ({ port }) => {
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: GATEWAY_TOKEN,
        scopes: ["operator.read"],
        timeoutMs: 60_000,
      });
      try {
        const got = await client.request<{ artifact?: { id?: string } }>("artifacts.get", {
          sessionKey: SESSION_KEY,
          artifactId: paddedId,
        });
        expect(got.artifact).toMatchObject({ id: artifactId });

        const download = await client.request<{
          artifact?: { id?: string };
          url?: string;
        }>("artifacts.download", {
          sessionKey: SESSION_KEY,
          artifactId: paddedId,
        });
        expect(download.artifact).toMatchObject({ id: artifactId });
        expect(download.url).toEqual(expect.any(String));
        console.log(
          `[artifacts artifactId trim Gateway client E2E] get_ok=true download_ok=true padded=${JSON.stringify(paddedId)} exact=${artifactId}`,
        );
      } finally {
        await disconnectGatewayClient(client);
      }
    });
  }, 120_000);
});
