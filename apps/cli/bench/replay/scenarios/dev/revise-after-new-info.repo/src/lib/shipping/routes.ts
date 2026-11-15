// Shipping routes. A route sails each turn while it is active and both of its
// ports are open.
import type { Route, Port, Corporation } from "./types";

// A port closure suspends every route that calls there. The cargo stays on
// board and nothing is charged while a route is suspended.
export function onPortClosed(corps: Corporation[], port: Port, turn: number) {
  for (const corp of corps) {
    for (const route of corp.routes) {
      if (route.destination === port.id || route.origin === port.id) {
        route.status = "suspended";
        route.suspendedTurn = turn;
        route.suspendedBecause = "port_closed";
      }
    }
  }
}

// Reopening a port does NOT resume its routes. By design the owner resumes a
// suspended route from the route page, so they can change ships or cargo
// first. Until then the route stays suspended and makes no deliveries.
export function onPortReopened(corps: Corporation[], port: Port, turn: number) {
  port.status = "open";
  port.reopenedTurn = turn;
  for (const corp of corps) {
    for (const route of corp.routes) {
      if (route.status === "suspended" && route.suspendedBecause === "port_closed" && touches(route, port)) route.resumable = true;
    }
  }
}

// Called from the route page's Resume button.
export function resumeRoute(route: Route, ports: Map<string, Port>) {
  const open = ports.get(route.origin)?.status === "open" && ports.get(route.destination)?.status === "open";
  if (!open) return { ok: false, error: "A port on this route is closed" };
  route.status = "active";
  route.suspendedBecause = undefined;
  route.resumable = false;
  return { ok: true };
}

function touches(route: Route, port: Port) {
  return route.destination === port.id || route.origin === port.id;
}
