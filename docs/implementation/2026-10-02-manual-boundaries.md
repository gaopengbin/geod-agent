# 手动范围与书签

## 产品行为

地图左上角增加紧凑工具栏：矩形、多边形、编辑、范围书签。

- 矩形：按住鼠标拖动；多边形：逐点点击、双击结束，支持撤销顶点和 Esc 取消。
- 绘制完成后可拖动顶点调整形状，填写名称并保存；“用于对话”同时设置当前对话的范围附件。
- 书签支持选择、定位、编辑、重命名与删除；范围保存在现有原生存储，书签按会话持久保存。
- 编辑和重命名产生新的原生范围 ID，并更新书签引用。已有下载计划继续引用原来的范围。
- 删除仅移除书签；已有计划及原生范围记录仍保留。
- AI 可通过现有 `boundaries_list` 发现保存的范围，并通过 `boundaryId` 规划下载，无需再复制几何坐标。
- AI 正在回复或请求尚未确定结果时，地图允许编辑和保存书签，使用范围的操作会提示等待回复结束。

## 接入位置

- `src/manual-boundaries.tsx`：OpenLayers Draw / Modify / Snap、范围校验和保存、书签界面。
- `src/manual-boundaries.css`：沿用当前 LibreChat 主题变量，稳定大小的按钮、紧凑弹层。
- `src/boundary-bookmarks.ts`：版本化的本机会话书签索引。
- `src/boundary-selection.ts`：地图与对话之间的范围选择通道。
- `src/openlayers-map-view.tsx`：加载工具栏，允许编辑当前任务范围。
- `src/agent-panel.tsx`：接收范围后调用已有 `attachRange`。
- `src/components/motion/popover-morph.tsx`：修复重复打开时子面板停留在裁剪隐藏状态的问题，子节点显式控制进入与离开动画。

## 2026-10-02 验证

`npm run build` 已通过。

使用独立 headless Edge 页面和真实 Tauri IPC，未切换用户当前会话、未重启原生程序。验收记录在 `evidence/manual-boundaries/acceptance.json`，截图在同目录。

已验证：

1. 实际鼠标拖动绘制矩形，坐标经原生 GeoJSON 校验并持久保存。
2. 实际鼠标逐点绘制三角形。
3. 实际鼠标拖动顶点，保存后几何改变，原 ID 的几何保持不变。
4. 书签重命名写入原生范围名称，当前对话使用更新后的 ID 和名称。
5. 书签删除、定位、刷新恢复及会话隔离。
6. 保存后的范围能从原生 `boundaries_list` 读回。
7. 深色、浅色和 720px 窄屏截图，页面无额外横向滚动，弹层未超出视口。
8. 页面没有脚本异常。

验收脚本：`test/manual-boundaries-native-bridge.mjs`（1422，只允许隔离验收会话的范围 IPC）、`test/manual-boundaries-harness.html` 和 `test/manual-boundaries-ui.mjs`。Playwright 路径通过脚本参数传入，应用不依赖该测试运行时。

当前证据覆盖界面交互和原生范围存储；这组测试没有触发真实模型请求或下载。完整模型与下载验收由桌面能力补齐主流程完成。
