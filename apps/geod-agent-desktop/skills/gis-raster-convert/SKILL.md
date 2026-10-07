---
name: gis-raster-convert
description: Convert geographic rasters, compress, build overviews, create COG and reproject.
---

# 栅格转换

Inspect using raster_info. Use raster_convert or raster_reproject through this skill's GIS MCP connector. Respect actual source CRS and data type. Provide CRS and resampling methodology for reprojection. Writes require fullAccess, a new output file and an existing directory. Verify the resulting raster using raster_info.

Discover the exact connector ID and schemas through extensions_list; do not invent tool names. Use mcp_call for processing and report only actual returned results. Dependencies are installed separately and reused on this device. If a required component is missing, direct the user to this skill in 技能与连接器; never install packages through shell or silently switch to a system Python.
