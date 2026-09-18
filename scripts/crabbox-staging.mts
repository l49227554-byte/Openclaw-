import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  verifySourceWitness,
  type FrozenSource,
  type SourceWitness,
} from "./crabbox-staging-witness.mts";

const prefix = "openclaw-crabbox-sync-";
const receiptName = "staging.json";
const manifestName = "manifest.json";
const headerLimit = 32 * 1024;
const manifestLimit = 64 * 1024 * 1024;
const identitySchema = z.strictObject({ dev: z.string(), ino: z.string() });
const witnessSchema = z.strictObject({
  gitDir: z.string(),
  ref: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
});
const receiptSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  ownerPid: z.number().int().min(2),
  repository: z.string(),
  kind: z.literal("capsule"),
  rootIdentity: identitySchema,
  payloadIdentity: identitySchema,
  durable: z.boolean(),
  users: z.enum(["none", "admitted", "settled"]),
  state: z.enum(["preparing", "prepared", "admitted", "settled", "preserved", "removing"]),
  manifest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  witness: witnessSchema.optional(),
  hold: z.enum(["artifacts", "claims", "writers"]).optional(),
});
type Receipt = z.infer<typeof receiptSchema>;
type Identity = z.infer<typeof identitySchema>;
const entrySchema = z.strictObject({
  path: z.string().min(1),
  kind: z.enum(["file", "symlink", "directory"]),
  mode: z.enum(["100644", "100755", "120000"]).optional(),
  blob: z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .optional(),
});
type Entry = z.infer<typeof entrySchema>;
const sourceEntrySchema = z.strictObject({
  path: z.string().min(1),
  mode: z.enum(["100644", "100755", "120000"]),
  blob: z.string().regex(/^[a-f0-9]{40}$/u),
});
const manifestSchema = z.strictObject({
  source: z.strictObject({
    files: z.array(sourceEntrySchema),
    deleted: z.array(z.string()),
  }),
  entries: z.array(entrySchema),
});
type Manifest = z.infer<typeof manifestSchema>;

function identity(path: string): Identity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("staging directory was replaced: " + path);
  }
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(left: Identity, right: Identity) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertIdentity(path: string, expected: Identity) {
  if (!sameIdentity(identity(path), expected)) {
    throw new Error("staging directory identity changed: " + path);
  }
}

function safeRelative(path: string) {
  return (
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function readBounded(path: string, limit: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) {
      throw new Error("staging metadata is not a bounded regular file");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error("staging metadata changed while reading");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string) {
  // Windows does not expose a directory flush through this Node API. Such
  // receipts remain useful for inspection, but never authorize orphan removal.
  if (process.platform === "win32") {
    return false;
  }
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
    return true;
  } finally {
    closeSync(fd);
  }
}

function writeAtomic(root: string, name: string, bytes: string) {
  const temporary = join(root, "." + name + "." + randomUUID());
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(root, name));
    syncDirectory(root);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function blob(path: string, symbolic: boolean) {
  if (symbolic) {
    const bytes = readlinkSync(path, { encoding: "buffer" });
    return createHash("sha1")
      .update("blob " + bytes.length + "\0")
      .update(bytes)
      .digest("hex");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) {
      throw new Error("staging contains an unsupported file");
    }
    const hash = createHash("sha1").update("blob " + before.size + "\0");
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = readSync(fd, buffer);
      if (!count) {
        break;
      }
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("staging content changed while reading");
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function inventory(payload: string, known = new Map<string, Entry>()): Entry[] {
  const entries: Entry[] = [];
  const walk = (directory: string, parent: string) => {
    for (const name of readdirSync(directory)) {
      const path = parent ? parent + "/" + name : name;
      if (!safeRelative(path)) {
        throw new Error("staging contains an unsupported path");
      }
      const absolute = join(payload, path);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        entries.push({ path, kind: "directory" });
        walk(absolute, path);
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        const symbolic = stat.isSymbolicLink();
        const mode = symbolic ? "120000" : stat.mode & 0o100 ? "100755" : "100644";
        const frozen = known.get(path);
        if (frozen && frozen.mode !== mode) {
          throw new Error("source mode changed before sealing: " + path);
        }
        entries.push({
          path,
          kind: symbolic ? "symlink" : "file",
          mode,
          blob: frozen?.blob ?? blob(absolute, symbolic),
        });
      } else {
        throw new Error("staging contains an unsupported file kind: " + path);
      }
    }
  };
  walk(payload, "");
  return entries.toSorted((a, b) => a.path.localeCompare(b.path));
}

function readReceipt(root: string) {
  identity(root);
  let receipt: Receipt;
  try {
    receipt = receiptSchema.parse(
      JSON.parse(readBounded(join(root, receiptName), headerLimit).toString("utf8")),
    );
  } catch {
    throw new Error("staging receipt has unknown or invalid metadata");
  }
  if (basename(root) !== prefix + receipt.id) {
    throw new Error("staging generation does not match its directory");
  }
  assertIdentity(root, receipt.rootIdentity);
  return receipt;
}

function ownerAbsent(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export type StagingHandle = {
  root: string;
  payload: string;
  prepared: (source: FrozenSource, witness?: SourceWitness) => void;
  admitted: () => void;
  settled: () => void;
  hold: (reason: NonNullable<Receipt["hold"]>) => void;
  dispose: () => void;
};

export function createStaging(syncRoot: string, repository: string): StagingHandle {
  mkdirSync(syncRoot, { recursive: true });
  const id = randomUUID();
  const root = join(realpathSync(syncRoot), prefix + id);
  mkdirSync(root, { mode: 0o700 });
  const payload = join(root, "payload");
  let receipt: Receipt;
  try {
    mkdirSync(payload, { mode: 0o700 });
    receipt = {
      version: 1,
      id,
      ownerPid: process.pid,
      repository: realpathSync(repository),
      kind: "capsule",
      rootIdentity: identity(root),
      payloadIdentity: identity(payload),
      durable: syncDirectory(root),
      users: "none",
      state: "preparing",
    };
    writeAtomic(root, receiptName, JSON.stringify(receipt) + "\n");
    syncDirectory(dirname(root));
  } catch (error) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Staging preparation failed; allocation retained at " + root,
        { cause: cleanupError },
      );
    }
    throw error;
  }
  const update = (fields: Partial<Receipt>) => {
    assertIdentity(root, receipt.rootIdentity);
    receipt = { ...receipt, ...fields };
    writeAtomic(root, receiptName, JSON.stringify(receipt) + "\n");
  };
  let disposed = false;
  return {
    root,
    payload,
    prepared(source, witness) {
      const known = new Map<string, Entry>(
        source.files.map((entry) => [
          "source/" + entry.path,
          {
            ...entry,
            path: "source/" + entry.path,
            kind: entry.mode === "120000" ? "symlink" : "file",
          },
        ]),
      );
      const manifest: Manifest = { source, entries: inventory(payload, known) };
      const bytes = JSON.stringify(manifest) + "\n";
      if (Buffer.byteLength(bytes) > manifestLimit) {
        throw new Error("staging manifest exceeds the recovery metadata limit");
      }
      writeAtomic(root, manifestName, bytes);
      update({
        state: "prepared",
        manifest: createHash("sha256").update(bytes).digest("hex"),
        witness,
      });
    },
    admitted: () => update({ state: "admitted", users: "admitted" }),
    settled: () => update({ state: "settled", users: "settled" }),
    hold: (hold) => update({ hold }),
    dispose() {
      if (disposed) {
        return;
      }
      // The live producer may dispose its own dirty snapshot after normal
      // settlement. Independent-source proof applies only to a later owner.
      update({ state: "removing" });
      assertIdentity(payload, receipt.payloadIdentity);
      rmSync(payload, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      disposed = true;
    },
  };
}

export type StagingStatus = {
  id: string;
  directory: string;
  status: "active" | "protected" | "candidate";
  reason: string;
};

function metadataStatus(root: string, receipt: Receipt): StagingStatus {
  const base = { id: receipt.id, directory: root };
  if (lstatSync(join(root, "recovery.lock"), { throwIfNoEntry: false })) {
    return {
      ...base,
      status: "protected",
      reason:
        "Another or interrupted recovery owns this copy; inspect that operation before manual disposition.",
    };
  }
  if (!ownerAbsent(receipt.ownerPid)) {
    return {
      ...base,
      status: "active",
      reason: "The producer PID is live or cannot be checked; wait for its cleanup.",
    };
  }
  if (!receipt.durable || !receipt.manifest) {
    return {
      ...base,
      status: "protected",
      reason:
        "Preparation or durable recovery metadata is incomplete; preserve this copy for inspection.",
    };
  }
  if (receipt.users === "admitted" || receipt.state === "preparing") {
    return {
      ...base,
      status: "protected",
      reason: "Writer settlement was not recorded; PID absence does not authorize removal.",
    };
  }
  if (receipt.hold || receipt.users === "settled") {
    return {
      ...base,
      status: "protected",
      reason:
        "Claim or diagnostic preservation is incomplete; repair and preserve the named outputs before recovery.",
    };
  }
  if (receipt.state !== "prepared" && receipt.state !== "removing") {
    return {
      ...base,
      status: "protected",
      reason: "Staging state is inconsistent with recorded ownership; preserve it for inspection.",
    };
  }
  if (!receipt.witness) {
    return {
      ...base,
      status: "protected",
      reason:
        "No independent retained Git ref is recorded; preserve the snapshot in a retained repository first.",
    };
  }
  return {
    ...base,
    status: "candidate",
    reason: "Source preservation and unchanged contents must still be verified before removal.",
  };
}

export function inspectStaging(
  syncRoot: string,
  options: { limit?: number; budgetMs?: number } = {},
) {
  const started = performance.now();
  const entries: StagingStatus[] = [];
  let incomplete = false;
  let directory;
  try {
    directory = opendirSync(syncRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries, incomplete, elapsedMs: performance.now() - started };
    }
    throw error;
  }
  try {
    for (;;) {
      if (
        entries.length >= (options.limit ?? 64) ||
        performance.now() - started >= (options.budgetMs ?? 250)
      ) {
        incomplete = true;
        break;
      }
      const entry = directory.readSync();
      if (!entry) {
        break;
      }
      if (!entry.name.startsWith(prefix)) {
        continue;
      }
      const root = join(syncRoot, entry.name);
      try {
        entries.push(metadataStatus(root, readReceipt(root)));
      } catch {
        entries.push({
          id: entry.name,
          directory: root,
          status: "protected",
          reason: "Unmarked, unknown, replaced or unreadable staging; no automatic adoption.",
        });
      }
    }
  } finally {
    directory.closeSync();
  }
  return { entries, incomplete, elapsedMs: performance.now() - started };
}

function validatePayload(root: string, receipt: Receipt, manifest: Manifest) {
  const payload = join(root, "payload");
  assertIdentity(payload, receipt.payloadIdentity);
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  if (
    expected.size !== manifest.entries.length ||
    [...expected.keys()].some((path) => !safeRelative(path))
  ) {
    throw new Error("staging manifest contains duplicate or unsafe paths");
  }
  const actual = inventory(payload);
  for (const entry of actual) {
    const frozen = expected.get(entry.path);
    if (
      !frozen ||
      frozen.kind !== entry.kind ||
      frozen.mode !== entry.mode ||
      frozen.blob !== entry.blob
    ) {
      throw new Error("staging contents changed or gained an entry: " + entry.path);
    }
    expected.delete(entry.path);
  }
  if (expected.size && receipt.state !== "removing") {
    throw new Error("staging contents are missing before disposal");
  }
  return JSON.stringify(actual);
}

export async function recoverStaging(syncRoot: string, id: string) {
  if (!z.uuid().safeParse(id).success) {
    return { id, recovered: false, reason: "Choose a recorded staging ID from staging inspect." };
  }
  const root = join(syncRoot, prefix + id);
  let locked = false;
  let unsettled = false;
  let lockedRoot: Identity | undefined;
  let lockedDirectory: Identity | undefined;
  const lockOwner = JSON.stringify({ pid: process.pid, generation: randomUUID() }) + "\n";
  const lock = join(root, "recovery.lock");
  try {
    const before = readReceipt(root);
    const status = metadataStatus(root, before);
    if (status.status !== "candidate") {
      return { id, recovered: false, reason: status.reason };
    }
    // A dead recovery owner is not a settlement receipt for its child tools.
    // Interrupted recovery locks stay protected rather than being stolen.
    mkdirSync(lock, { mode: 0o700 });
    locked = true;
    lockedRoot = identity(root);
    lockedDirectory = identity(lock);
    writeFileSync(join(lock, "owner.json"), lockOwner, { mode: 0o600, flag: "wx" });
    const receipt = readReceipt(root);
    if (JSON.stringify(receipt) !== JSON.stringify(before) || !ownerAbsent(receipt.ownerPid)) {
      throw new Error("staging ownership changed while acquiring recovery");
    }
    const bytes = readBounded(join(root, manifestName), manifestLimit);
    if (createHash("sha256").update(bytes).digest("hex") !== receipt.manifest) {
      throw new Error("staging manifest does not match its receipt");
    }
    let manifest: Manifest;
    try {
      manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new Error("staging manifest has unknown or invalid metadata");
    }
    const metadataNames = new Set([receiptName, manifestName, "payload", "recovery.lock"]);
    if (readdirSync(root).some((name) => !metadataNames.has(name))) {
      throw new Error("staging has an unknown metadata sibling; preserve it before recovery");
    }
    const footprint = validatePayload(root, receipt, manifest);
    const witness = await verifySourceWitness({
      source: manifest.source,
      witness: receipt.witness!,
      payloadRoot: root,
    });
    if (!witness.ok) {
      unsettled = witness.unjoined === true;
      return { id, recovered: false, reason: witness.reason };
    }
    // Verification yields while Git reads the external witness. Revalidate
    // ownership and the complete remaining payload before the destructive step.
    if (
      JSON.stringify(readReceipt(root)) !== JSON.stringify(receipt) ||
      !ownerAbsent(receipt.ownerPid)
    ) {
      throw new Error("staging ownership changed during preservation verification");
    }
    if (validatePayload(root, receipt, manifest) !== footprint) {
      throw new Error("staging changed during preservation verification");
    }
    assertIdentity(lock, lockedDirectory);
    if (readdirSync(root).some((name) => !metadataNames.has(name))) {
      throw new Error("staging metadata changed during preservation verification");
    }
    writeAtomic(root, receiptName, JSON.stringify({ ...receipt, state: "removing" }) + "\n");
    witness.revalidate();
    rmSync(join(root, "payload"), { recursive: true, force: true });
    rmSync(join(root, manifestName));
    rmSync(join(root, receiptName));
    rmSync(join(lock, "owner.json"));
    rmdirSync(lock);
    locked = false;
    // Nonrecursive removal preserves an unexpected sibling placed beside metadata.
    rmdirSync(root);
    return {
      id,
      recovered: true,
      reason: "Independent retained source verified; abandoned staging removed.",
    };
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "Another or interrupted recovery owns this copy; inspect its owner before manual disposition."
        : error instanceof Error
          ? error.message
          : "Staging recovery could not be verified.";
    return { id, recovered: false, reason };
  } finally {
    if (locked && !unsettled && lockedRoot && lockedDirectory) {
      try {
        assertIdentity(root, lockedRoot);
        assertIdentity(lock, lockedDirectory);
        if (readBounded(join(lock, "owner.json"), headerLimit).toString("utf8") === lockOwner) {
          rmSync(join(lock, "owner.json"));
          rmdirSync(lock);
        }
      } catch {
        // A replaced or incomplete recovery owner never grants cleanup authority.
      }
    }
  }
}

export async function runStagingCommand(args: string[], syncRoot: string) {
  if (args.length === 1 && args[0] === "inspect") {
    console.log(JSON.stringify(inspectStaging(syncRoot), null, 2));
    return 0;
  }
  if (args.length === 2 && args[0] === "recover") {
    const result = await recoverStaging(syncRoot, args[1]!);
    console.log(JSON.stringify(result, null, 2));
    return result.recovered ? 0 : 1;
  }
  console.log(
    "Usage: node scripts/crabbox-wrapper.mjs staging inspect\n       node scripts/crabbox-wrapper.mjs staging recover <id>\n\nOnly positively settled, unchanged staging with independently retained source can be removed.",
  );
  return args.length === 0 || args[0] === "--help" ? 0 : 2;
}
