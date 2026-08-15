import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { Shell } from "./shell.js";
import { HomePage } from "./views/home.js";
import { SettingsPage } from "./views/settings.js";
import { WorkbenchPage } from "./views/workbench.js";

const rootRoute = createRootRoute({
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  )
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const workbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/sessions/$sessionId",
  component: WorkbenchPage
});

const routeTree = rootRoute.addChildren([indexRoute, settingsRoute, workbenchRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
