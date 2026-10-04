import { toolDefinitions } from "openlayers-mcp-protocol";
import type { ZodRawShape } from "zod";

/** The browser and MCP registration use the same versioned upstream contract. */
export function registerOpenLayersDefinitions(register: (name: string, description: string, schema: ZodRawShape) => void) {
  for (const [name, definition] of Object.entries(toolDefinitions)) register(name, definition.description, definition.schema.shape);
}
