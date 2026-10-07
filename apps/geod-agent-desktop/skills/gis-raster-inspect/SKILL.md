---
name: gis-raster-inspect
description: Inspect geographic raster metadata, bands and pixel statistics.
---

# 栅格检查

Use raster_info and raster_stats through this skill's GIS MCP connector. Read actual CRS, band count, nodata and pixel statistics. Metadata does not prove imagery acquisition date. Statistics are computed using windows to avoid loading whole rasters.

Discover the exact connector ID and schemas through extensions_list; do not invent tool names. Use mcp_call for processing and report only actual returned results. Dependencies are installed separately and reused on this device. If a required component is missing, direct the user to this skill in 技能与连接器; never install packages through shell or silently switch to a system Python.
