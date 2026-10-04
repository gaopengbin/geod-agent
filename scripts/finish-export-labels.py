from pathlib import Path
for name in ['plan-review-card.tsx', 'task-panel.tsx', 'task-queue-view.tsx']:
    p = Path('apps/geod-agent-desktop/src') / name
    text = p.read_text(encoding='utf-8')
    text = text.replace('format => format === "geotiff" ? "GeoTIFF" : "MBTiles"', 'outputFormatLabel')
    text = text.replace('GeoTIFF 按多边形边界裁剪；MBTiles 保留源瓦片。', 'GeoTIFF、PNG 和 JPEG 按边界裁剪；瓦片容器保留源瓦片。')
    text = text.replace('GeoTIFF 按边界裁剪，MBTiles 保留源瓦片。', 'GeoTIFF、PNG 和 JPEG 按边界裁剪；瓦片容器保留源瓦片。')
    p.write_text(text, encoding='utf-8', newline='\n')
