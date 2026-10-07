---
name: gis-vector-convert
description: Convert vector file formats and reproject vector data in the current workspace.
---

# 矢量转换

Inspect the source using vector_info. Use vector_convert or vector_reproject through this skill's GIS MCP connector. Inspect the source CRS, supply methodology for reprojection, and keep output in the current workspace. Never overwrite an existing file. Writes require fullAccess.

Discover the exact connector ID and schemas through extensions_list; do not invent tool names. Use mcp_call for processing and report only actual returned results. Dependencies are installed separately and reused on this device. If a required component is missing, direct the user to this skill in 技能与连接器; never install packages through shell or silently switch to a system Python.
