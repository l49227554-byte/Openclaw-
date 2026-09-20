/**
 * Environment variable substitution for config values.
 *
 * Supports `${VAR_NAME}` syntax in string values, substituted at config load time.
 * - Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
 * - Escape with `$${}` to output literal `${}`
 * - Missing env vars throw `MissingEnvVarError` with context
 *
 * @example
 * ```json5
 * {
 *   models: {
 *     providers: {
 *       "vercel-gateway": {
 *         apiKey: "${VERCEL_GATEWAY_API_KEY}"
 *       }
 *     }
 *   }
 * }
 * ```
 */

// Pattern for valid uppercase env var names: starts with letter or underscore,
// followed by letters, numbers, or underscores (all uppercase)
import { appendConfigPathSegment } from "../shared/dot-path.js";
import { isPlainObject } from "../utils.js";
import { parseEnvTemplateSecretRef } from "./types.secrets.js";

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Error thrown when a config value references a missing or empty environment variable. */
export class MissingEnvVarError extends Error {
  constructor(
    public readonly varName: string,
    public readonly configPath: string,
  ) {
    super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
    this.name = "MissingEnvVarError";
  }
}

type EnvToken =
  | { kind: "escaped"; name: string; end: number }
  | { kind: "substitution"; name: string; end: number };

function parseEnvTokenAt(value: string, index: number): EnvToken | null {
  if (value[index] !== "$") {
    return null;
  }

  const next = value[index + 1];
  const afterNext = value[index + 2];

  // Escaped: $${VAR} -> ${VAR}
  if (next === "$" && afterNext === "{") {
    // Parse escaped placeholders before substitutions so "$${VAR}" never resolves from env.
    const start = index + 3;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const name = value.slice(start, end);
      if (ENV_VAR_NAME_PATTERN.test(name)) {
        return { kind: "escaped", name, end };
      }
    }
  }

  // Substitution: ${VAR} -> value
  if (next === "{") {
    const start = index + 2;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const name = value.slice(start, end);
      if (ENV_VAR_NAME_PATTERN.test(name)) {
        return { kind: "substitution", name, end };
      }
    }
  }

  return null;
}

/** Missing environment variable warning emitted when substitution is configured to continue. */
export type EnvSubstitutionWarning = {
  varName: string;
  configPath: string;
};

type SubstituteOptions = {
  /** When set, missing vars call this instead of throwing and the original placeholder is preserved. */
  onMissing?: (warning: EnvSubstitutionWarning) => void;
  /** Records exact env SecretRef shorthand that substitution did not materialize. */
  onPendingEnvSecretRef?: (id: string, configPath: string) => void;
  /** Records the source of an exact env SecretRef shorthand that substitution materialized. */
  onResolvedEnvSecretRef?: (id: string, configPath: string) => void;
};

function substituteString(
  value: string,
  env: NodeJS.ProcessEnv,
  configPath: string,
  opts?: SubstituteOptions,
): string {
  if (!value.includes("$")) {
    return value;
  }

  const authoredRef = parseEnvTemplateSecretRef(value);
  if (authoredRef && !containsEnvVarReference(value)) {
    opts?.onPendingEnvSecretRef?.(authoredRef.id, configPath);
  }
  const chunks: string[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (char !== "$") {
      chunks.push(char);
      continue;
    }

    const token = parseEnvTokenAt(value, i);
    if (token?.kind === "escaped") {
      chunks.push(`\${${token.name}}`);
      i = token.end;
      continue;
    }
    if (token?.kind === "substitution") {
      const envValue = env[token.name];
      if (envValue === undefined || envValue === "") {
        if (opts?.onMissing) {
          opts.onMissing({ varName: token.name, configPath });
          if (authoredRef?.id === token.name) {
            opts.onPendingEnvSecretRef?.(token.name, configPath);
          }
          // Preserve the original placeholder so the value is visibly unresolved.
          chunks.push(`\${${token.name}}`);
          i = token.end;
          continue;
        }
        throw new MissingEnvVarError(token.name, configPath);
      }
      if (authoredRef?.id === token.name) {
        opts?.onResolvedEnvSecretRef?.(token.name, configPath);
      }
      chunks.push(envValue);
      i = token.end;
      continue;
    }

    // Leave untouched if not a recognized pattern
    chunks.push(char);
  }

  return chunks.join("");
}

/** Detects unescaped `${VAR}` references without treating escaped `$${VAR}` as references. */
export function containsEnvVarReference(value: string): boolean {
  if (!value.includes("$")) {
    return false;
  }

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== "$") {
      continue;
    }

    const token = parseEnvTokenAt(value, i);
    if (token?.kind === "escaped") {
      i = token.end;
      continue;
    }
    if (token?.kind === "substitution") {
      return true;
    }
  }

  return false;
}

type SubstituteTask = {
  value: unknown;
  path: string;
  /** Output container holding this value's slot; array slots use numeric keys. */
  slot: Record<string, unknown> | unknown[];
  /** Key of this value's slot inside `slot`. */
  key: string;
};

function substituteAny(
  value: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
  opts?: SubstituteOptions,
): unknown {
  if (typeof value === "string") {
    return substituteString(value, env, path, opts);
  }

  const rootIsArray = Array.isArray(value);
  if (!rootIsArray && !isPlainObject(value)) {
    // Primitives (number, boolean, null) pass through unchanged
    return value;
  }

  // Driver loop: each pending container becomes a heap frame instead of a
  // call frame, so document depth costs heap and previously accepted deep
  // configs keep substituting instead of overflowing the call stack. Slots
  // are allocated while expanding the parent so object key order follows the
  // source document, and children are pushed in reverse so leaves resolve in
  // the same depth-first order as the recursive walk.
  const result: Record<string, unknown> | unknown[] = rootIsArray ? [] : {};
  const stack: SubstituteTask[] = [];

  const writeSlot = (
    slot: Record<string, unknown> | unknown[],
    key: string,
    resolved: unknown,
  ): void => {
    if (Array.isArray(slot)) {
      slot[Number(key)] = resolved;
    } else {
      slot[key] = resolved;
    }
  };

  const expandContainer = (
    source: Record<string, unknown> | unknown[],
    containerPath: string,
    slot: Record<string, unknown> | unknown[],
  ): void => {
    const sourceIsArray = Array.isArray(source);
    const children: SubstituteTask[] = [];
    for (const [key, val] of Object.entries(source)) {
      const childPath = sourceIsArray
        ? `${containerPath}[${key}]`
        : appendConfigPathSegment(containerPath, key);
      const childIsArray = Array.isArray(val);
      const childIsObject = !childIsArray && isPlainObject(val);
      if (childIsArray || childIsObject) {
        const child: Record<string, unknown> | unknown[] = childIsArray ? [] : {};
        writeSlot(slot, key, child);
        children.push({ value: val, path: childPath, slot: child, key });
      } else {
        // Reserve the slot now so key order matches the document; the leaf
        // task below overwrites it with the resolved value without moving it.
        writeSlot(slot, key, undefined);
        children.push({ value: val, path: childPath, slot, key });
      }
    }
    for (const child of children.toReversed()) {
      stack.push(child);
    }
  };

  if (Array.isArray(value)) {
    expandContainer(value, path, result);
  } else if (isPlainObject(value)) {
    expandContainer(value, path, result);
  }
  while (stack.length > 0) {
    const task = stack.pop()!;
    if (Array.isArray(task.value)) {
      expandContainer(task.value, task.path, task.slot);
      continue;
    }
    if (isPlainObject(task.value)) {
      expandContainer(task.value, task.path, task.slot);
      continue;
    }
    writeSlot(
      task.slot,
      task.key,
      typeof task.value === "string"
        ? substituteString(task.value, env, task.path, opts)
        : task.value,
    );
  }
  return result;
}

/**
 * Resolves `${VAR_NAME}` environment variable references in config values.
 *
 * @param obj - The parsed config object (after JSON5 parse and $include resolution)
 * @param env - Environment variables to use for substitution (defaults to process.env)
 * @param opts - Options: `onMissing` callback to collect warnings instead of throwing.
 * @returns The config object with env vars substituted
 * @throws {MissingEnvVarError} If a referenced env var is not set or empty (unless `onMissing` is set)
 */
export function resolveConfigEnvVars(
  obj: unknown,
  env: NodeJS.ProcessEnv = process.env,
  opts?: SubstituteOptions,
): unknown {
  return substituteAny(obj, env, "", opts);
}
