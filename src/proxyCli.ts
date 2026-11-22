#!/usr/bin/env node
/**
 * mcp-write-gate-proxy: gate the write tools of an MCP stdio server that has
 * no gate of its own. See USAGE in proxyArgs.ts.
 *
 *   mcp-write-gate-proxy --env-prefix GOOGLE_SLIDES \
 *     --write-tools create_presentation,batch_update_presentation \
 *     -- /path/to/run-mcp.sh
 */
import { startProxy } from "./proxy.js";
import { parseProxyArgs, UsageError, USAGE, type ProxyArgs } from "./proxyArgs.js";
import { createWriteGate } from "./writeGate.js";

function log(line: string): void {
  process.stderr.write(`mcp-write-gate-proxy: ${line}\n`);
}

let parsed: ProxyArgs;
try {
  parsed = parseProxyArgs(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`mcp-write-gate-proxy: ${error.message}\n\n${USAGE}`);
  process.exit(2);
}

const gate = createWriteGate({ writeTools: new Set(parsed.writeTools), envPrefix: parsed.envPrefix });
const { exited } = startProxy({
  command: parsed.command,
  args: parsed.args,
  gate,
  env: process.env,
  input: process.stdin,
  output: process.stdout,
  signals: process,
  killTimeoutMs: parsed.killTimeoutMs,
  log,
});
void exited.then((code) => process.exit(code));
