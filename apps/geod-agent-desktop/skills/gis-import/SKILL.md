---
name: gis-import
description: Import local Shapefile, GeoPackage, KML/KMZ, GML, FGB, WKT or CSV geometry as a download range.
---

# 多格式范围导入

Use data_input_read with the user-supplied workspace path or data handle. List layers when ambiguous, respect known CRS, never guess a missing CRS. To inspect files use vector_info through the matching GIS MCP connector.

Discover the exact connector ID and schemas through extensions_list; do not invent tool names. Use mcp_call for processing and report only actual returned results. Dependencies are installed separately and reused on this device. If a required component is missing, direct the user to this skill in 技能与连接器; never install packages through shell or silently switch to a system Python.
