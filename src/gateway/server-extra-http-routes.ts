import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayServerExtraHttpRoute } from "./server-extra-handlers.js";

type AuthorizeRouteParams = Parameters<
  typeof import("./http-auth-utils.js").authorizePluginGatewayHttpRequestOrReply
>[0];

export async function authorizeGatewayHttpRouteOrReply(
  params: AuthorizeRouteParams,
): ReturnType<typeof import("./http-auth-utils.js").authorizePluginGatewayHttpRequestOrReply> {
  const { authorizePluginGatewayHttpRequestOrReply } = await import("./http-auth-utils.js");
  return await authorizePluginGatewayHttpRequestOrReply(params);
}

export async function handleServerExtraHttpRoute(
  routes: readonly GatewayServerExtraHttpRoute[] | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  auth: Omit<AuthorizeRouteParams, "req" | "res" | "requestPath" | "resolveOperatorScopes">,
): Promise<boolean> {
  const route = routes?.find((candidate) => candidate.path === requestPath);
  if (!route) {
    return false;
  }
  const authResult = await authorizeGatewayHttpRouteOrReply({
    req,
    res,
    requestPath,
    resolveOperatorScopes: () => [],
    ...auth,
  });
  return authResult ? await route.handler(req, res) : true;
}
