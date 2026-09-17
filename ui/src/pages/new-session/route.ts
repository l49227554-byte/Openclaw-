import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { takeInstantThreadRestore } from "./instant-thread-restore.ts";

export const page = definePage({
  ...routePageSpec("new-session"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: async (context: ApplicationContext, { location, cause }) =>
    (cause !== "preload" && takeInstantThreadRestore(context, location.search)) ||
    (await import("./route-loader.ts")).load(context, location.search),
  component: () => import("./new-session-page-entry.ts"),
});
