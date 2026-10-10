# GeoD Agent taskbar icon sizing

- User reported the violet icon looked smaller than neighboring Windows taskbar icons.
- Kept the violet ribbon G, sparkle and plum rounded-square backing. Generated a tightly framed native icon variant with imagegen from the existing app icon.
- Source: `apps/geod-agent-desktop/assets/branding/geod-agent-v2-violet/geod-agent-app-taskbar.png`.
- Original generation retained at `C:/Users/Administrator/.codex/generated_images/01a0e5c2-8233-7833-b50d-1e52fbb46660/exec-eb28cfb1-5357-46e1-b8cb-c964c90c9b0f.png`.
- Opaque tile bounds (alpha >= 128) changed from `(73,82,1181,1170)` to `(16,22,1238,1230)` on a 1254-square canvas: width 88.4% to 97.4%. The G was enlarged within the tile as well.
- Exported through Tauri icon tooling and replaced native PNG, ICO and ICNS assets. ICO contains 16, 24, 32, 48, 64 and 256 pixel variants. Inspected the 32 pixel asset.
- Added explicit icon change tracking in `build.rs` so development resource builds refresh after icon updates.
- Native debug build succeeded. Restarted the owned development preview after confirming no active AI turns, commands or downloads. Existing installed applications were preserved.
- This is a development update; no installer or public release was published. Export validation does not establish Windows shell cache behavior on other machines.

## Follow-up: increase inner padding

- User requested a more prominent outer tile and a smaller G. Generated a second native variant with the built-in imagegen tool, preserving violet ribbon G and sparkle and increasing inner padding. Inspected its 32 pixel export.
- Active source: `apps/geod-agent-desktop/assets/branding/geod-agent-v2-violet/geod-agent-app-taskbar-v2.png`. Original and first variants are retained.
- Generation source: `C:/Users/Administrator/.codex/generated_images/01a0e5c2-8233-7833-b50d-1e52fbb46660/exec-c6802f5e-d3ef-4bd5-9b1f-8e7517ed9c41.png`.
- Prompt: edit only spacing and scale; rounded plum tile nearly fills the square canvas; reduce the G and sparkle to a comfortably padded centered mark; preserve silhouette, palette, material and corner shape; transparent outside corners, no text or external shadow.
- Export folder: `artifacts/brand-geod-agent-taskbar-v2-20261009/icons`. Replaced the native icon assets and rebuilt the development executable.

## Follow-up: full canvas outer tile

- Active native source is now `apps/geod-agent-desktop/assets/branding/geod-agent-v2-violet/geod-agent-app-taskbar-v3.png`.
- Built-in imagegen edit from v2: expand the plum tile to the canvas edges, retain G and sparkle scale and position, slightly reduce corner rounding and strengthen the violet rim for small taskbar sizes; preserve palette/material; no text or external shadow, transparency only outside corners.
- Generation retained at `C:/Users/Administrator/.codex/generated_images/01a0e5c2-8233-7833-b50d-1e52fbb46660/exec-e759f7bb-9ffe-4567-940e-1e3aa7fd9cad.png`.
- Exported with Tauri into `artifacts/brand-geod-agent-taskbar-v3-20261009/icons` and replaced native assets. Inspected the 32 pixel export and rebuilt the development application.
