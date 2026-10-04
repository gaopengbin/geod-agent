import { createServer } from "node:http";

let callCount = 0;
const server = createServer(async (request, response) => {
  if (request.url !== "/mcp" || request.method !== "POST") {
    response.writeHead(405, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const answer = body.method === "initialize"
    ? { protocolVersion: body.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "geod-mcp-mock", version: "0.1.0" } }
    : body.method === "tools/list"
      ? { tools: [
          { name: "echo", description: "Return text for MCP integration verification", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
          { name: "large_result", description: "Return a long result for paging verification", inputSchema: { type: "object", properties: {} } },
        ] }
      : body.method === "tools/call"
        ? { content: [{ type: "text", text: body.params?.name === "large_result" ? "中国影像图层".repeat(2_000) : `${String(body.params?.arguments?.text ?? "")} (call ${++callCount})` }] }
        : null;
  if (body.id === undefined) {
    response.writeHead(202);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer }));
});

server.listen(43121, "127.0.0.1", () => process.stdout.write("MCP mock listening on 127.0.0.1:43121\n"));
