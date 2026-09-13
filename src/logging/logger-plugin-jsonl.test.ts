import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSubsystemLogger, getChildLogger } from "../plugin-sdk/logging-core.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { startPluginServices } from "../plugins/services.js";
import { readConfiguredLogTail } from "./log-tail.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { applyLoggingConfig, flushLogger, resetLogger } from "./logger.js";
import { testApi } from "./logger.test-support.js";
import { getDefaultRedactPatterns } from "./redact.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";
import { loggingState } from "./state.js";

const paths = createSuiteLogPathTracker("openclaw-plugin-jsonl-");
let rawConsole: typeof loggingState.rawConsole;
beforeAll(async () => await paths.setup());
beforeEach(() => {
  rawConsole = loggingState.rawConsole;
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
  vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
});
afterEach(async () => {
  await flushLogger();
  testApi.resetFileLogTransportForTests();
  testApi.setHostnameResolverForTests();
  resetLogger();
  resetSecretRedactionRegistryForTest();
  loggingState.rawConsole = rawConsole;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => await paths.cleanup());

async function logFromPlugin(
  message: string,
  meta?: Record<string, unknown>,
  patterns?: string[],
  write?: (logger: ReturnType<typeof getChildLogger>) => void,
) {
  const file = paths.nextPath();
  applyLoggingConfig({
    level: "info",
    file,
    consoleStyle: "json",
    consoleLevel: "info",
    redactPatterns: patterns,
  });
  const output = vi.fn();
  loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
  const logger = createSubsystemLogger("jsonl-proof");
  const host = createPluginRegistry({
    logger,
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "jsonl-proof",
    source: import.meta.url,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  host.registry.plugins.push(record);
  const api = host.createApi(record, { config: {} });
  api.registerService({
    id: record.id,
    start() {
      if (write) {
        write(getChildLogger({ subsystem: record.id }));
      } else if (meta) {
        logger.info(message, meta);
      } else {
        api.logger.info(message);
      }
    },
  });
  const services = await startPluginServices({ registry: host.registry, config: {} });
  await services.stop();
  await flushLogger();
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  return {
    lines,
    records: lines.map((line) => JSON.parse(line)),
    console: output.mock.calls.map(([line]) => JSON.parse(String(line))),
  };
}

it("registered plugin logger writes quoted credentials as valid file and console JSON", async () => {
  const result = await logFromPlugin('--token "synthetic-credential-123456"');
  expect(result.records).toHaveLength(1);
  expect(result.console).toHaveLength(1);
  for (const record of [...result.records, ...result.console]) {
    expect(record.message).toBe("***");
  }
  expect((await readConfiguredLogTail()).lines).toEqual(result.lines);
});

it.each([
  { name: "anchored", patterns: ["^private-value$"], value: "private-value", expected: "***" },
  {
    name: "contextual",
    patterns: ['"value":"(private-value)"'],
    value: "private-value",
    expected: "***",
  },
  {
    name: "ordered",
    patterns: ["MASKME", String.raw`/\*\*\* (PRIVATE_[A-Z]+)/g`],
    value: "MASKME PRIVATE_VALUE",
    expected: "*** ***",
  },
  { name: "numeric", patterns: ['"value":(42)'], value: 42, expected: "***" },
  { name: "boolean", patterns: ['"value":(true)'], value: true, expected: "***" },
  { name: "null", patterns: ['"value":(null)'], value: null, expected: "***" },
])(
  "registered plugin service logger preserves $name masking on JSON scalar tokens",
  async ({ patterns, value, expected }) => {
    const result = await logFromPlugin("scalar proof", { value }, [
      ...getDefaultRedactPatterns(),
      ...patterns,
    ]);
    expect(result.records[0]["1"].value).toBe(expected);
    expect(result.console[0].value).toBe(expected);
  },
);

it("registered plugin service logger applies explicit rules to preserved references", async () => {
  const result = await logFromPlugin(
    "reference proof",
    { session: "$WORKSPACE_DIR/private-value.jsonl", TOKEN: "$TOKEN", safe: "$SAFE" },
    [...getDefaultRedactPatterns(), "private-value", String.raw`\$TOKEN`],
  );
  for (const record of [result.records[0]["1"], result.console[0]]) {
    expect(record).toMatchObject({
      session: "$WORKSPACE_DIR/***.jsonl",
      TOKEN: "***",
      safe: "$SAFE",
    });
  }
});

it("registered plugin service logger masks registered numeric secrets and reloads policy", async () => {
  registerSecretValueForRedaction("987654321");
  const result = await logFromPlugin("registry proof", { value: 987654321, nested: [987654321] });
  for (const record of [result.records[0]["1"], result.console[0]]) {
    expect(record).toMatchObject({ value: "***", nested: ["***"] });
  }
  const reloaded = await logFromPlugin("reload proof", { value: "reload-private" }, [
    "^reload-private$",
  ]);
  expect(reloaded.records[0]["1"].value).toBe("***");
  expect(reloaded.console[0].value).toBe("***");
});

it("registered plugin logger keeps built-in file protection with custom-only rules", async () => {
  const result = await logFromPlugin(
    "sk-syntheticcredential123456 CUSTOM_ONLY_VALUE",
    { "Proxy-Authorization": "Digest username=OPAQUE_USER, response=OPAQUE_RESPONSE" },
    ["CUSTOM_ONLY_[A-Z]+"],
  );
  expect(result.records[0].message).not.toContain("sk-syntheticcredential123456");
  expect(result.records[0].message).not.toContain("CUSTOM_ONLY_VALUE");
  expect(result.console[0].message).not.toContain("CUSTOM_ONLY_VALUE");
  expect(result.records[0]["1"]["Proxy-Authorization"]).toContain("***");
  expect(result.console[0]["Proxy-Authorization"]).toContain("***");
  expect(JSON.stringify(result.records)).not.toContain("OPAQUE_RESPONSE");
  expect(JSON.stringify(result.console)).not.toContain("OPAQUE_RESPONSE");
});

it("registered plugin logger produces valid overflow JSON with a quoted hostname", async () => {
  testApi.setFileLogQueueMaxRecordsForTests(1);
  testApi.setHostnameResolverForTests(() => '--token "synthetic-credential-123456"');
  const result = await logFromPlugin("overflow", undefined, undefined, (logger) => {
    logger.info("first");
    logger.info("second");
  });
  expect(result.records[0].dropped).toBe(1);
  expect(result.records[0].hostname).not.toContain("synthetic-credential-123456");
});

it("registered plugin service logger projects ordered native argument masks into its display message", async () => {
  let conversions = 0;
  const fields = { stage: "MASKME", account: 123456, next: "PRIVATE_VALUE", ordinary: "visible" };
  const patterns = [
    ...getDefaultRedactPatterns(),
    "MASKME",
    String.raw`/"account":(123456)/g`,
    String.raw`/"account":"\*\*\*","next":"(PRIVATE_[A-Z]+)"/g`,
  ];
  const result = await logFromPlugin("native", undefined, patterns, (logger) => {
    logger.info(
      "derived ordered",
      new (class {
        toJSON() {
          conversions += 1;
          return fields;
        }
      })(),
    );
  });
  expect(conversions).toBe(1);
  expect(result.records).toHaveLength(1);
  expect(result.records[0].message).toBe(
    'derived ordered {"stage":"***","account":"***","next":"***","ordinary":"visible"}',
  );
  expect(JSON.stringify(result.records)).not.toContain("PRIVATE_VALUE");
});
