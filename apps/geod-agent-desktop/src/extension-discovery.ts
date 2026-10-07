import type { ExtensionOverview, McpConnector, McpToolList } from "./api";

/** Models often search with several capability keywords rather than one exact phrase. */
function matchesQuery(text: string, query: string) {
  if (!query || text.toLowerCase().includes(query)) return true;
  const terms = query.split(/[\s,，、;；/|]+/).filter(term => term && !["mcp", "tool", "tools", "and", "or"].includes(term));
  return terms.some(term => text.toLowerCase().includes(term));
}

/** Registration is account-local configuration, independent of whether tools are enabled or reachable. */
export function connectorRegistration(connector:McpConnector){
  return {connectorId:connector.id,name:connector.name,url:connector.url,registered:true,enabled:connector.enabled,
    status:connector.enabled?'enabled':'notEnabled',
    authenticationConfigured:!!(connector.queryNames?.length||connector.headerNames?.length||connector.envNames?.length||connector.oauth)};
}

/** A connector match selects its tools; a tool match selects that tool's schema. */
export function discoveredConnector(connector: Pick<McpConnector, "id" | "name" | "url">, list: McpToolList, query = "") {
  const needle = query.trim().toLowerCase().slice(0, 80);
  const connectorMatches = matchesQuery(`${connector.id} ${connector.name} ${connector.url} ${list.name}`, needle);
  const matched = connectorMatches ? list.tools : list.tools.filter(tool => matchesQuery(`${tool.name} ${tool.description ?? ""} ${Object.keys(tool.inputSchema.properties ?? {}).join(' ')}`, needle));
  if (!connectorMatches && !matched.length) return null;
  return {
    connectorId: connector.id, name: connector.name, url:connector.url,registered:true,enabled:true,status:'enabled',toolCount: list.tools.length,
    matchedToolCount: matched.length, availableTools: matched.map(tool => tool.name), tools: matched.slice(0, 32),
    ...(matched.length > 32 ? { omittedToolCount: matched.length - 32, next: "Use extensions_list with a specific tool name or capability to obtain its complete schema" } : {}),
  };
}

export async function discoverExtensions(
  installed: ExtensionOverview,
  query: string,
  toolsFor: (id: string) => Promise<McpToolList>,
  builtin: McpToolList[] = [],
) {
  const needle = query.trim().toLowerCase().slice(0, 80);
  const registeredApps = (installed.registeredApps ?? []).filter(app => matchesQuery(`${app.pluginName} ${app.name} ${app.registeredId} ${app.category ?? ""}`, needle));
  const referenced = new Set(registeredApps.filter(app => app.route === "bundledMcp" && app.connectorId).map(app => app.connectorId));
  const direct=installed.connectors.filter(item=>referenced.has(item.id)||matchesQuery(`${item.id} ${item.name} ${item.url}`,needle));
  const enabled = installed.connectors.filter(item => item.enabled&&(!needle||!direct.length||direct.some(found=>found.id===item.id)));
  const results = await Promise.allSettled(enabled.map(item => toolsFor(item.id)));
  return {
    registeredApps,
    registeredConnectors:installed.connectors.map(connectorRegistration),
    skills: installed.skills.filter(item => item.enabled && matchesQuery(`${item.name} ${item.description}`, needle)).map(item => ({ name: item.name, description: item.description })),
    connectors: [
      ...builtin.map(list => discoveredConnector({ id: list.connectorId, name: list.name, url: "" }, list, needle)),
      ...enabled.map((item, index) => {
        const result = results[index];
        return result.status === "fulfilled" ? discoveredConnector(item, result.value, referenced.has(item.id) ? "" : needle)
          : referenced.has(item.id) || matchesQuery(`${item.id} ${item.name} ${item.url}`, needle)
            ? { ...connectorRegistration(item),status:'unavailable',error: "CONNECTOR_UNAVAILABLE", message: result.reason instanceof Error ? result.reason.message : "Tool discovery failed" } : null;
      }),
      ...installed.connectors.filter(item=>!item.enabled&&(referenced.has(item.id)||matchesQuery(`${item.id} ${item.name} ${item.url}`,needle))).map(item=>({...connectorRegistration(item),availableTools:[],tools:[],requiresUserReview:true,next:'This connector is already saved, but not enabled. Do not re-add it or ask for its URL/key again. Use mcp_connect with this connectorId to prepare a user enable-review card; never enable it automatically.'})),
    ].filter(item => item !== null),
  };
}
