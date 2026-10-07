---
name: gis-vector-analysis
description: Clip vectors, generate buffers and simplify geometry in the current workspace.
---

# 矢量分析

Inspect the source using vector_info. Use vector_clip, vector_buffer or vector_simplify through this skill's GIS MCP connector. Buffer distance and simplify tolerance use source CRS units: inspect CRS first. Respect the user's range, topology and output format. Writes require fullAccess and new output paths.

Discover the exact connector ID and schemas through extensions_list; do not invent tool names. Use mcp_call for processing and report only actual returned results. Dependencies are installed separately and reused on this device. If a required component is missing, direct the user to this skill in 技能与连接器; never install packages through shell or silently switch to a system Python.
