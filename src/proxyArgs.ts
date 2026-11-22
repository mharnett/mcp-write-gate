/** Command-line parsing for the `mcp-write-gate-proxy` bin. */

export const USAGE = `Usage: mcp-write-gate-proxy --env-prefix PREFIX --write-tools a,b[,...] [--kill-timeout-ms N] -- <server command> [args...]

Runs the MCP stdio server as a child and gates its write tools: they are
dropped from tools/list and a tools/call to one gets an error, unless
PREFIX_MCP_WRITE is true, 1 or yes.

  --env-prefix PREFIX      e.g. GOOGLE_SLIDES reads GOOGLE_SLIDES_MCP_WRITE
  --write-tools a,b        tool names to gate; may repeat
  --kill-timeout-ms N      wait after forwarding a signal before SIGKILL (default 1500)
`;

export class UsageError extends Error {}

export interface ProxyArgs {
  envPrefix: string;
  writeTools: string[];
  killTimeoutMs: number;
  command: string;
  args: string[];
}

const PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function parseProxyArgs(argv: readonly string[]): ProxyArgs {
  let envPrefix: string | undefined;
  const writeTools: string[] = [];
  let sawWriteTools = false;
  let killTimeoutMs = 1500;

  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const server = separator === -1 ? [] : argv.slice(separator + 1);

  for (let i = 0; i < own.length; i++) {
    const token = own[i]!;
    const eq = token.indexOf("=");
    const flag = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
    const value = (): string => {
      if (eq !== -1 && flag !== token) return token.slice(eq + 1);
      const next = own[i + 1];
      if (next === undefined) throw new UsageError(`${flag} needs a value`);
      i++;
      return next;
    };
    switch (flag) {
      case "--env-prefix":
        envPrefix = value();
        break;
      case "--write-tools":
        sawWriteTools = true;
        writeTools.push(
          ...value()
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        );
        break;
      case "--kill-timeout-ms": {
        const raw = value();
        const parsed = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new UsageError(`--kill-timeout-ms must be a positive integer, got ${JSON.stringify(raw)}`);
        }
        killTimeoutMs = parsed;
        break;
      }
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(token)}`);
    }
  }

  if (envPrefix === undefined) throw new UsageError("--env-prefix is required");
  if (!PREFIX_PATTERN.test(envPrefix)) {
    throw new UsageError(`--env-prefix must look like GOOGLE_SLIDES, got ${JSON.stringify(envPrefix)}`);
  }
  if (writeTools.length === 0) {
    throw new UsageError(
      sawWriteTools ? "--write-tools named no tools" : "--write-tools is required: a gate with no write tools gates nothing",
    );
  }
  const [command, ...args] = server;
  if (command === undefined || command === "") {
    throw new UsageError("missing the server command after --");
  }
  return { envPrefix, writeTools: [...new Set(writeTools)], killTimeoutMs, command, args };
}
