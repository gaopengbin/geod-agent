import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  type StoredPlan,
  type BoundaryImport,
  type BoundarySummary,
} from "../src/api";
import { SchedulePanel } from "../src/schedule-panel";
import { BoundaryPicker } from "../src/boundary-picker";
import { MapView } from "../src/openlayers-map-view";
import { TooltipProvider } from "../src/ui-tooltip";
import { ScrollArea } from "../src/components/ui/scroll-area";
import { Button } from "../src/components/motion/button/base";
import fixture from "./schedule-ui-fixture.json";
import "ol/ol.css";
import "../src/styles.css";
import "../src/theme.css";
function Harness() {
  const [theme, setTheme] = useState<"light" | "dark">("dark"),
    [plan, setPlan] = useState<StoredPlan | null>(null),
    [items, setItems] = useState<BoundarySummary[]>([]),
    [active, setActive] = useState<BoundaryImport | null>(null),
    [status, setStatus] = useState("真实 SQLite 与本机作业记录");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    void api.plansGet(fixture.planId).then(setPlan);
    void api.boundariesList(fixture.boundaryConversationId).then(setItems);
  }, []);
  return (
    <TooltipProvider>
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          background: "var(--app-surface)",
          color: "var(--app-text)",
        }}
      >
        <aside
          style={{
            width: 260,
            padding: 20,
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <strong>输入范围</strong>
          <p style={{ fontSize: 12, color: "var(--app-soft-text)" }}>
            {status}
          </p>
          <Button
            variant="ghost"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            切换明暗主题
          </Button>
          <div style={{ marginTop: "auto" }}>
            <BoundaryPicker
              items={items}
              active={active}
              disabled={false}
              onSelect={async (id) =>
                setActive(
                  await api.boundariesGet(fixture.boundaryConversationId, id),
                )
              }
              onCombine={async (ids) => {
                setActive(
                  await api.boundariesCombine(
                    fixture.boundaryConversationId,
                    ids,
                  ),
                );
                setItems(
                  await api.boundariesList(fixture.boundaryConversationId),
                );
              }}
              onClear={() => setActive(null)}
              onError={(error) => setStatus(String(error))}
            />
          </div>
        </aside>
        <MapView
          conversationId={fixture.conversationId}
          bounds={plan?.plan.spec.bounds ?? null}
          boundary={plan?.plan.spec.boundary ?? null}
          tileGrids={[]}
          completedTiles={null}
          preview={null}
          missingTiles={0}
          theme={theme}
        />
        <aside
          className="task-panel"
          style={{
            width: 360,
            minWidth: 360,
            borderLeft: "1px solid var(--border)",
            padding: 16,
          }}
        >
          <h3 style={{ fontSize: 14, margin: "4px 0 20px" }}>
            任务与成果 · 定时
          </h3>
          <ScrollArea style={{ height: "calc(100% - 48px)" }}>
            <SchedulePanel
              conversationId={fixture.conversationId}
              plan={plan}
              title="文件范围影像"
              onOpenRun={(run) => setStatus(`本次执行：${run.state}`)}
            />
          </ScrollArea>
        </aside>
      </div>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
