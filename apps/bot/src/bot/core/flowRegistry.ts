import type { Flow, FlowModule } from "./flowTypes.js";

export function makeMenuMap(modules: FlowModule[]) {
  return Object.fromEntries(modules.map((m) => [m.menuText, m.flow])) as Record<
    string,
    Flow
  >;
}

export function getModuleByFlow(modules: FlowModule[], flow: Flow) {
  return modules.find((m) => m.flow === flow);
}

export function routeByPrefix(modules: FlowModule[], data: string) {
  return modules.find((m) => data.startsWith(m.cbPrefix));
}
