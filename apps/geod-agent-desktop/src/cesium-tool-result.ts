import { validateCesiumToolOutput } from 'cesium-mcp-contracts';

/** Validate the JSON actually sent over MCP, omitting optional undefined fields. */
export function cesiumToolResult(name: string, value: unknown): unknown {
  const result = JSON.parse(JSON.stringify(value));
  const validation = validateCesiumToolOutput(name, result);
  if (validation.knownTool && !validation.valid) return {
    success: false, error: 'INVALID_SCENE_RESULT', issues: validation.issues,
  };
  return result;
}
