import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Contract test: the real MCP SDK client talks to a real MCP SDK server through
// the built bin, so the proxy is checked against the SDK's own framing,
// handshake and shutdown sequence, not just against our fake.
// Containment: the server is test/fixtures/sdkMcpServer.mjs (SDK only, no
// network, no credentials).
const BIN = fileURLToPath(new URL("../dist/proxyCli.js", import.meta.url));
const SDK_SERVER = fileURLToPath(new URL("../test/fixtures/sdkMcpServer.mjs", import.meta.url));
const ENV_VAR = "FAKE_SLIDES_MCP_WRITE";

const clients: Client[] = [];

async function connect(writes: boolean): Promise<Client> {
  if (!existsSync(BIN)) throw new Error(`${BIN} is missing: run \`npm run build\` first`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== ENV_VAR) env[k] = v;
  if (writes) env[ENV_VAR] = "true";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      BIN,
      "--env-prefix",
      "FAKE_SLIDES",
      "--write-tools",
      "create_presentation,batch_update_presentation",
      "--",
      process.execPath,
      SDK_SERVER,
    ],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "proxy-contract-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
});

describe("mcp-write-gate-proxy with the MCP SDK on both sides", () => {
  it("completes the handshake, hides the write tools and refuses a direct call", async () => {
    const client = await connect(false);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_page", "get_presentation", "summarize_presentation"]);

    const read = await client.callTool({ name: "get_page", arguments: {} });
    expect(read.content).toEqual([{ type: "text", text: "called get_page" }]);

    await expect(client.callTool({ name: "batch_update_presentation", arguments: {} })).rejects.toThrow(
      `${ENV_VAR}=true`,
    );
  });

  it("passes the write tools through when the opt-in env var is set", async () => {
    const client = await connect(true);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("batch_update_presentation");
    const write = await client.callTool({ name: "create_presentation", arguments: {} });
    expect(write.content).toEqual([{ type: "text", text: "called create_presentation" }]);
  });

  it("shuts down on the SDK client's close without needing a signal", async () => {
    const client = await connect(false);
    const transport = client.transport as StdioClientTransport;
    const pid = transport.pid;
    expect(pid).toBeTypeOf("number");
    const started = Date.now();
    await client.close();
    clients.splice(clients.indexOf(client), 1);
    // The SDK waits up to 2 s for exit after closing stdin, then sends SIGTERM.
    expect(Date.now() - started).toBeLessThan(1900);
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});
