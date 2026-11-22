/**
 * A stdio proxy that puts the write gate in front of an MCP server we can't
 * (or won't) change, such as a fork of a copyleft upstream.
 *
 * The server runs as a child process and the proxy waits on it: it is never
 * exec'd, so the proxy outlives it, forwards signals to it and reports its
 * exit code. The proxy reads newline-delimited JSON-RPC (MCP's stdio framing)
 * from both sides and changes only two things:
 *
 *   - a `tools/list` response loses the write tools (gate.filterTools);
 *   - a `tools/call` to a write tool is answered with an error by the proxy
 *     and never reaches the server (gate.assertWriteAllowed).
 *
 * Both are skipped when the gate's `<PREFIX>_MCP_WRITE` env var is set.
 * Everything else, notifications and cancellations included, is forwarded.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { WriteGate } from "./writeGate.js";

/** Splits a byte stream into lines: MCP stdio framing (`\n`, optional `\r`). */
export class LineBuffer {
  private buffer: Buffer = Buffer.alloc(0);

  /** Append a chunk; return the complete, non-blank lines it finished. */
  push(chunk: Buffer | string): string[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);
    const lines: string[] = [];
    let index: number;
    // Split on the byte, decode per line: a multi-byte character cut across
    // two chunks is decoded only once both halves are here.
    while ((index = this.buffer.indexOf(0x0a)) !== -1) {
      const line = this.buffer.toString("utf8", 0, index).replace(/\r$/, "");
      this.buffer = this.buffer.subarray(index + 1);
      if (line.trim().length > 0) lines.push(line);
    }
    return lines;
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON-RPC ids are strings or numbers, and 7 and "7" are different requests. */
function idKey(id: unknown): string {
  return JSON.stringify(id);
}

const INVALID_PARAMS = -32602;
const PARSE_ERROR = -32700;

export interface ClientDecision {
  /** What to send on to the server, if anything. */
  forward?: unknown;
  /** What to answer the client with directly. */
  reply?: unknown;
  /** Write tools refused in this message, for the log. */
  refused: string[];
}

/**
 * The message-level gate, separate from the process plumbing. It tracks
 * pending `tools/list` request ids so it can filter exactly their responses.
 */
export function createMessageGate(gate: WriteGate, env: NodeJS.ProcessEnv = process.env) {
  const pendingToolLists = new Set<string>();

  function refusal(msg: JsonObject): string | undefined {
    if (msg.method !== "tools/call") return undefined;
    const name = isObject(msg.params) ? msg.params.name : undefined;
    if (typeof name !== "string") return undefined;
    try {
      gate.assertWriteAllowed(name, env);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }

  function one(msg: unknown, refused: string[]): { forward?: unknown; reply?: unknown } {
    if (!isObject(msg)) return { forward: msg };
    const denied = refusal(msg);
    if (denied !== undefined) {
      refused.push(String((msg.params as JsonObject).name));
      // A notification gets no answer, but it still never reaches the server.
      if (!("id" in msg)) return {};
      return {
        reply: { jsonrpc: "2.0", id: msg.id, error: { code: INVALID_PARAMS, message: denied } },
      };
    }
    if (msg.method === "tools/list" && "id" in msg) pendingToolLists.add(idKey(msg.id));
    return { forward: msg };
  }

  return {
    /** A message from the client, bound for the server. */
    fromClient(msg: unknown): ClientDecision {
      const refused: string[] = [];
      if (!Array.isArray(msg)) return { ...one(msg, refused), refused };
      // A JSON-RPC batch: gate each element, forward what survives.
      const forwards: unknown[] = [];
      const replies: unknown[] = [];
      for (const element of msg) {
        const decision = one(element, refused);
        if ("forward" in decision) forwards.push(decision.forward);
        if (decision.reply !== undefined) replies.push(decision.reply);
      }
      return {
        ...(forwards.length > 0 ? { forward: forwards } : {}),
        ...(replies.length > 0 ? { reply: replies } : {}),
        refused,
      };
    },

    /** A message from the server, bound for the client. */
    fromServer(msg: unknown): unknown {
      if (Array.isArray(msg)) return msg.map((element) => this.fromServer(element));
      if (!isObject(msg) || "method" in msg || !("id" in msg)) return msg;
      const key = idKey(msg.id);
      if (!pendingToolLists.has(key)) return msg;
      pendingToolLists.delete(key);
      const result = msg.result;
      if (!isObject(result) || !Array.isArray(result.tools)) return msg;
      const tools = result.tools.filter(isObject) as Array<{ name: string }>;
      return { ...msg, result: { ...result, tools: gate.filterTools(tools, env) } };
    },
  };
}

export interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  removeListener(event: NodeJS.Signals, listener: () => void): unknown;
}

export interface ProxyOptions {
  /** The server to run, e.g. its `run-mcp.sh`. */
  command: string;
  args?: readonly string[];
  gate: WriteGate;
  /** Read by the gate and passed to the child. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** From the MCP client (process.stdin). */
  input: Readable;
  /** To the MCP client (process.stdout). */
  output: Writable;
  /** Where SIGTERM/SIGINT/SIGHUP arrive (process). */
  signals: SignalSource;
  /**
   * After forwarding a signal, how long to wait before SIGKILL. The MCP SDK
   * client allows 2 s between SIGTERM and SIGKILL, so stay under that.
   */
  killTimeoutMs?: number;
  /** One-line diagnostics (stderr). */
  log?: (line: string) => void;
}

export interface RunningProxy {
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the exit code once the child has exited and output is flushed. */
  exited: Promise<number>;
}

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

export function startProxy(options: ProxyOptions): RunningProxy {
  const env = options.env ?? process.env;
  const killTimeoutMs = options.killTimeoutMs ?? 1500;
  const log = options.log ?? (() => undefined);
  const { input, output, signals } = options;
  const messages = createMessageGate(options.gate, env);

  const child = spawn(options.command, [...(options.args ?? [])], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  }) as unknown as ChildProcessWithoutNullStreams;

  let finished = false;
  let killTimer: NodeJS.Timeout | undefined;
  let lastWrite: Promise<void> = Promise.resolve();
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExited = resolve));

  function toClient(line: string): void {
    if (output.destroyed || output.writableEnded) return;
    lastWrite = new Promise((resolve) => output.write(line + "\n", () => resolve()));
  }

  function toServer(msg: unknown): void {
    if (!child.stdin.writable) return;
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  function terminate(signal: NodeJS.Signals): void {
    if (finished) return;
    child.kill(signal);
    if (killTimer === undefined) {
      killTimer = setTimeout(() => {
        if (!finished) {
          log(`server ignored ${signal} for ${killTimeoutMs} ms; sending SIGKILL`);
          child.kill("SIGKILL");
        }
      }, killTimeoutMs);
    }
  }

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => terminate(signal);
    signalHandlers.set(signal, handler);
    signals.on(signal, handler);
  }

  function finish(code: number): void {
    if (finished) return;
    finished = true;
    if (killTimer !== undefined) clearTimeout(killTimer);
    for (const [signal, handler] of signalHandlers) signals.removeListener(signal, handler);
    input.removeListener("data", onInput);
    void lastWrite.then(() => resolveExited(code));
  }

  // Client -> server.
  const fromClient = new LineBuffer();
  function onInput(chunk: Buffer | string): void {
    for (const line of fromClient.push(chunk)) {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        // Fail closed: what we can't read, we don't pass on.
        toClient(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } }));
        continue;
      }
      const decision = messages.fromClient(msg);
      for (const name of decision.refused) log(`refused tools/call ${name}: writes are off`);
      if (decision.reply !== undefined) toClient(JSON.stringify(decision.reply));
      if ("forward" in decision) toServer(decision.forward);
    }
  }
  input.on("data", onInput);
  input.on("end", () => child.stdin.end());
  input.on("error", () => child.stdin.end());

  // Server -> client.
  const fromServer = new LineBuffer();
  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of fromServer.push(chunk)) {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        toClient(line); // Not ours to judge; the client sees what the server sent.
        continue;
      }
      toClient(JSON.stringify(messages.fromServer(msg)));
    }
  });

  // A write after the server has gone (EPIPE) must not crash the proxy.
  child.stdin.on("error", (error) => log(`server stdin: ${error.message}`));
  // The client went away: don't leave the server running with its credentials.
  output.on("error", () => terminate("SIGTERM"));

  child.on("error", (error) => {
    if (child.pid === undefined) {
      log(`failed to start ${options.command}: ${error.message}`);
      finish(127);
    } else {
      log(`server process error: ${error.message}`);
    }
  });
  child.on("close", (code, signal) => {
    if (child.pid === undefined) return; // never started: the "error" handler reports it
    if (code !== null) return finish(code);
    const number = signal ? osConstants.signals[signal] : undefined;
    finish(number !== undefined ? 128 + number : 1);
  });

  return { child, exited };
}
