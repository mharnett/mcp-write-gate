// A real MCP SDK stdio server with the Google Slides MCP's tool names and no
// behaviour behind them, for the proxy's SDK contract test.
// Containment: imports only the SDK's server, stdio transport and types; no
// network, no filesystem, no credentials.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const NAMES = [
  "create_presentation",
  "get_presentation",
  "batch_update_presentation",
  "get_page",
  "summarize_presentation",
];

const server = new Server({ name: "sdk-fixture", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: NAMES.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: `called ${request.params.name}` }],
}));
await server.connect(new StdioServerTransport());
