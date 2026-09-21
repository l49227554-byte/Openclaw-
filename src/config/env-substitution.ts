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
// Matches an env-var-shaped prefix followed by a shell parameter-expansion operator
// (:-, :=, :?, :+, or their bare forms), e.g. "VAR:-default" or "VAR-default".
// The prefix deliberately mirrors ENV_VAR_NAME_PATTERN's uppercase-only grammar: only a
// name the user could plausibly have meant as an env var is worth a diagnostic. Widening
// it to any identifier warns on ordinary placeholders from other template dialects
// (`${my-service}`, `${count+1}`), which this warning has no way to silence.
const SHELL_EXPANSION_OPERATOR_PATTERN = /^[A-Z_][A-Z0-9_]*:?[-=?+]/;

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

/** Warning emitted when a `${...}` expression uses shell parameter-expansion syntax that is not supported and is left literal. */
export type EnvUnsupportedExpressionWarning = {
  /**
   * The variable name and operator only, rendered as `${NAME:-...}`. Never the authored
   * fallback text: it can contain a secret, and consumers of this warning are not redacted.
   */
  expression: string;
  configPath: string;
};

type SubstituteOptions = {
  /** When set, missing vars call this instead of throwing and the original placeholder is preserved. */
  onMissing?: (warning: EnvSubstitutionWarning) => void;
  /** When set, unsupported shell parameter-expansion expressions call this instead of being silently left literal. */
  onUnsupportedExpression?: (warning: EnvUnsupportedExpressionWarning) => void;
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

    // Leave untouched if not a recognized pattern. Skip the second "$" of an
    // escaped "$${...}" so a deliberately escaped shell expression does not warn.
    if (value[i + 1] === "{" && !(i > 0 && value[i - 1] === "$")) {
      const start = i + 2;
      const end = value.indexOf("}", start);
      if (end !== -1) {
        const inner = value.slice(start, end);
        const operatorMatch = SHELL_EXPANSION_OPERATOR_PATTERN.exec(inner);
        if (!ENV_VAR_NAME_PATTERN.test(inner) && operatorMatch) {
          opts?.onUnsupportedExpression?.({
            // Report the variable name and operator only. Everything after the operator is
            // an author-supplied fallback that can hold a secret, and these warnings are not
            // redacted downstream: redactConfigSnapshot leaves snapshot.warnings untouched
            // and io.load.ts logs them. Never put the fallback payload in this string.
            expression: `\${${operatorMatch[0]}...}`,
            configPath,
          });
        }
      }
    }
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

function substituteAny(
  value: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
  opts?: SubstituteOptions,
): unknown {
  if (typeof value === "string") {
    return substituteString(value, env, path, opts);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => substituteAny(item, env, `${path}[${index}]`, opts));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteAny(val, env, appendConfigPathSegment(path, key), opts);
    }
    return result;
  }

  // Primitives (number, boolean, null) pass through unchanged
  return value;
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
