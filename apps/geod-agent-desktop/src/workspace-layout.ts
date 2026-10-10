export type WorkspaceMode = "focus" | "map" | "tasks";
export function workspaceArrangement(mode: WorkspaceMode, width: number, sidebarCollapsed = false) {
  const density = width >= 1440 ? "wide" : width >= 1120 ? "overlay" : width >= 900 ? "compact" : "single";
  const rail = sidebarCollapsed || density === "compact" || density === "single";
  const sidebar = rail ? 64 : 224;
  const defaults = mode === "focus" || density === "single" ? [sidebar, width - sidebar]
    : mode === "tasks" && (density === "wide" || density === "overlay")
      ? [sidebar, density === "wide" ? 480 : 340, width - sidebar - (density === "wide" ? 816 : 640), density === "wide" ? 336 : 300]
    : [sidebar, 480, width - sidebar - 480];
  const minimums = defaults.length === 2 ? [rail ? 64 : 180, Math.min(340, width - sidebar)]
    : defaults.length === 4 ? [rail ? 64 : 180, 340, 240, 300] : [rail ? 64 : 180, 340, 240];
  return { density, rail, key: `${density}-${defaults.length}${sidebarCollapsed && density !== "compact" && density !== "single" ? "-rail" : ""}`, defaults, minimums };
}

// A smaller window selects another arrangement instead of scaling down every panel.
export function fitPanelWidths(preferred: number[], width: number, minimums: number[]) {
  const total = preferred.reduce((sum, n) => sum + n, 0);
  const minimumTotal = minimums.reduce((sum, n) => sum + n, 0);
  const extra = preferred.map((n, i) => Math.max(0, n - minimums[i]));
  const extraTotal = extra.reduce((sum, n) => sum + n, 0);
  if (total === width && preferred.every((n, i) => n >= minimums[i])) return preferred;
  return minimums.map((n, i) => n + Math.max(0, width - minimumTotal) * (extraTotal ? extra[i] / extraTotal : i === minimums.length - 1 ? 1 : 0));
}

// Resize the nearest panel first, then borrow remaining space from its neighbours.
// A wide inspector must not strand space or stop as soon as the map reaches its minimum.
export function resizePanelWidths(initial: number[], minimums: number[], index: number, delta: number) {
  const next = [...initial];
  const donors = delta >= 0
    ? initial.map((_, i) => i).filter(i => i > index)
    : initial.map((_, i) => i).filter(i => i <= index).reverse();
  const receiver = delta >= 0 ? index : index + 1;
  const available = donors.reduce((sum, i) => sum + Math.max(0, initial[i] - minimums[i]), 0);
  let remaining = Math.min(Math.abs(delta), available);
  next[receiver] += remaining;
  for (const donor of donors) {
    const take = Math.min(remaining, Math.max(0, initial[donor] - minimums[donor]));
    next[donor] -= take;
    remaining -= take;
  }
  return next;
}
