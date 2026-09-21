import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  consumeGatewayFastPathRootOptionToken,
  consumeGatewayRunOptionToken,
} from "./gateway-run-argv.js";

export function isGatewayRunFastPathArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  const args = argv.slice(2);
  let sawGateway = false;
  let sawRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return false;
    }
    if (!sawGateway) {
      const consumed = consumeGatewayFastPathRootOptionToken(args, index);
      if (consumed > 0) {
        index += consumed - 1;
        continue;
      }
      if (arg !== "gateway") {
        return false;
      }
      sawGateway = true;
      continue;
    }

    const rootConsumed = consumeGatewayFastPathRootOptionToken(args, index);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    const consumed = consumeGatewayRunOptionToken(args, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (!sawRun && arg === "run") {
      sawRun = true;
      continue;
    }
    return false;
  }

  return sawGateway;
}
