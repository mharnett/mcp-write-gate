import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LineBuffer, startProxy, type RunningProxy } from "./proxy.js";
import { createWriteGate } from "./writeGate.js";

// Containment: every proxy here spawns `node test/fixtures/fakeMcpServer.mjs`,
// which has no imports and touches only its own stdin/stdout. No network, no
// Keychain, no real MCP server.
const FAKE_SERVER = fileURLToPath(new URL("../test/fixtures/fakeMcpServer.mjs", import.meta.url));
const PREFIX = "FAKE_SLIDES";
const ENV_VAR = `${PREFIX}_MCP_WRITE`;
const WRITE_TOOLS = new Set(["create_presentation", "batch_update_presentation"]);

type Msg = Record<string, any>;

interface Harness {
  proxy: RunningProxy;
  input: PassThrough;
  output: PassThrough;
  signals: EventEmitter;
  logs: string[];
  messages: unknown[];
  send(msg: unknown): void;
  sendRaw(text: string | Buffer): void;
  waitFor(pred: (m: Msg) => boolean, label?: string): Promise<Msg>;
  childReceived(pred: (m: any) => boolean, label?: string): Promise<any>;
  childReceivedAny(pred: (m: any) => boolean): boolean;
}

const running: Harness[] = [];

function start(
  opts: { env?: Record<string, string>; command?: string; args?: string[]; killTimeoutMs?: number } = {},
): Harness {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  if (!opts.env || !(ENV_VAR in opts.env)) delete env[ENV_VAR];

  const input = new PassThrough();
  const output = new PassThrough();
  const signals = new EventEmitter();
  const logs: string[] = [];
  const messages: unknown[] = [];
  const waiters: Array<() => void> = [];

  const proxy = startProxy({
    command: opts.command ?? process.execPath,
    args: opts.args ?? [FAKE_SERVER],
    gate: createWriteGate({ writeTools: WRITE_TOOLS, envPrefix: PREFIX }),
    env,
    input,
    output,
    signals,
    killTimeoutMs: opts.killTimeoutMs ?? 300,
    log: (line) => logs.push(line),
  });

  const reader = new LineBuffer();
  output.on("data", (chunk: Buffer) => {
    for (const line of reader.push(chunk)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = { raw: line };
      }
      messages.push(parsed);
    }
    for (const w of waiters.splice(0)) w();
  });

  // Arrays (batch replies) are included; a predicate reading `m.id` on one just sees undefined.
  const find = (pred: (m: Msg) => boolean) =>
    messages.find((m) => m !== null && typeof m === "object" && pred(m as Msg)) as Msg | undefined;

  const harness: Harness = {
    proxy,
    input,
    output,
    signals,
    logs,
    messages,
    send: (msg) => input.write(JSON.stringify(msg) + "\n"),
    sendRaw: (text) => input.write(text),
    waitFor(pred, label = "message") {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}; got ${JSON.stringify(messages)}`)),
          3000,
        );
        const check = () => {
          const hit = find(pred);
          if (hit) {
            clearTimeout(timer);
            resolve(hit);
          } else {
            waiters.push(check);
          }
        };
        check();
      });
    },
    childReceived(pred, label = "child to receive message") {
      return harness
        .waitFor((m) => m.method === "fake/received" && pred(m.params.message), label)
        .then((m) => m.params.message);
    },
    childReceivedAny(pred) {
      return messages.some(
        (m: any) => m && m.method === "fake/received" && pred(m.params.message),
      );
    },
  };
  running.push(harness);
  return harness;
}

/** Round-trip a request whose answer proves everything sent before it was processed by the child. */
async function sentinel(h: Harness, id: string | number): Promise<void> {
  h.send({ jsonrpc: "2.0", id, method: "ping" });
  await h.waitFor((m) => m.id === id && m.result?.echo === "ping", `sentinel ${id}`);
}

afterEach(async () => {
  for (const h of running.splice(0)) {
    const child = h.proxy.child;
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      child.kill("SIGKILL");
    }
    await h.proxy.exited.catch(() => undefined);
  }
});

describe("LineBuffer (MCP stdio framing)", () => {
  it("holds a partial line until its newline arrives", () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":')).toEqual([]);
    expect(buf.push('1}\n{"b"')).toEqual(['{"a":1}']);
    expect(buf.push(":2}\n")).toEqual(['{"b":2}']);
  });

  it("splits several messages in one chunk, strips CR and drops blank lines", () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":1}\r\n\n  \n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const bytes = Buffer.from('{"t":"café ✓"}\n', "utf8");
    const cut = bytes.indexOf(0xc3) + 1; // inside the two-byte "é"
    const buf = new LineBuffer();
    expect(buf.push(bytes.subarray(0, cut))).toEqual([]);
    expect(buf.push(bytes.subarray(cut))).toEqual(['{"t":"café ✓"}']);
  });
});

describe("startProxy: JSON-RPC framing through a real child", () => {
  it("reassembles a client message split across writes, including mid-character", async () => {
    const h = start();
    const bytes = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo/me", params: { t: "café ✓" } }) + "\n",
    );
    const cut = bytes.indexOf(0xc3) + 1;
    h.sendRaw(bytes.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 30));
    h.sendRaw(bytes.subarray(cut));
    const got = await h.childReceived((m) => m.id === 1);
    expect(got).toEqual({ jsonrpc: "2.0", id: 1, method: "echo/me", params: { t: "café ✓" } });
  });

  it("forwards several client messages from one write, in order", async () => {
    const h = start();
    h.sendRaw(
      '{"jsonrpc":"2.0","id":1,"method":"first"}\r\n\n{"jsonrpc":"2.0","id":2,"method":"second"}\n',
    );
    await h.waitFor((m) => m.id === 2 && m.result?.echo === "second");
    const order = h.messages
      .filter((m: any) => m?.method === "fake/received")
      .map((m: any) => m.params.message.method);
    expect(order).toEqual(["first", "second"]);
  });

  it("answers an unparseable client line with a parse error and never forwards it", async () => {
    const h = start();
    h.sendRaw("{not json\n");
    const err = await h.waitFor((m) => m.error?.code === -32700);
    expect(err).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
    await sentinel(h, "after-garbage");
    expect(h.messages.filter((m: any) => m?.method === "fake/received")).toHaveLength(1);
  });

  it("reassembles server output split across writes and several messages in one write", async () => {
    const h = start();
    const a = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { data: "a" } });
    const b = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { data: "b" } });
    const c = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { data: "c" } });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "fake/emit",
      params: { chunks: [a.slice(0, 10), a.slice(10) + "\n" + b + "\r\n" + c.slice(0, 5), c.slice(5) + "\n"] },
    });
    await h.waitFor((m) => m.id === 1 && m.result?.ok === true);
    const data = h.messages
      .filter((m: any) => m?.method === "notifications/message")
      .map((m: any) => m.params.data);
    expect(data).toEqual(["a", "b", "c"]);
  });

  it("passes a non-JSON server line through untouched", async () => {
    const h = start();
    h.send({ jsonrpc: "2.0", id: 1, method: "fake/emit", params: { chunks: ["server says hi\n"] } });
    await h.waitFor((m) => m.id === 1 && m.result?.ok === true);
    expect(h.messages).toContainEqual({ raw: "server says hi" });
  });
});

describe("startProxy: the write gate", () => {
  it("drops write tools from every tools/list page when writes are off", async () => {
    const h = start();
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const page1 = await h.waitFor((m) => m.id === 1 && "result" in m);
    expect(page1.result.tools.map((t: Msg) => t.name)).toEqual(["get_presentation"]);
    expect(page1.result.nextCursor).toBe("page-2");

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "page-2" } });
    const page2 = await h.waitFor((m) => m.id === 2 && "result" in m);
    expect(page2.result.tools.map((t: Msg) => t.name)).toEqual(["get_page", "summarize_presentation"]);
  });

  it("lists every tool when the opt-in env var is set", async () => {
    const h = start({ env: { [ENV_VAR]: "true" } });
    h.send({ jsonrpc: "2.0", id: "a", method: "tools/list" });
    const page1 = await h.waitFor((m) => m.id === "a" && "result" in m);
    expect(page1.result.tools.map((t: Msg) => t.name)).toEqual(["get_presentation", "create_presentation"]);
  });

  it("matches a tools/list response by exact id, so a lookalike id can't use up the filter", async () => {
    const h = start();
    // A string id and a number id that print the same are different requests.
    // One write, so tools/list "7" is pending before the child emits the lookalike.
    const lookalike = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: { tools: [{ name: "create_presentation" }] },
    });
    h.sendRaw(
      JSON.stringify({ jsonrpc: "2.0", id: 8, method: "fake/emit", params: { chunks: [lookalike + "\n"] } }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: "7", method: "tools/list" }) +
        "\n",
    );
    const echoed = await h.waitFor((m) => m.id === 7);
    expect(echoed.result.tools).toEqual([{ name: "create_presentation" }]);
    const real = await h.waitFor((m) => m.id === "7" && "result" in m);
    expect(real.result.tools.map((t: Msg) => t.name)).toEqual(["get_presentation"]);
  });

  it("refuses a write tools/call with an error and never forwards it", async () => {
    const h = start();
    h.send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "batch_update_presentation", arguments: { presentationId: "x" } },
    });
    const reply = await h.waitFor((m) => m.id === 5);
    expect(reply.result).toBeUndefined();
    expect(reply.error.code).toBe(-32602);
    expect(reply.error.message).toContain(`${ENV_VAR}=true`);
    await sentinel(h, "after-write");
    expect(h.childReceivedAny((m) => m?.method === "tools/call")).toBe(false);
    expect(h.logs.join("\n")).toContain("batch_update_presentation");
  });

  it("forwards a write tools/call when the opt-in env var is set", async () => {
    const h = start({ env: { [ENV_VAR]: "1" } });
    h.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "create_presentation" } });
    const reply = await h.waitFor((m) => m.id === 5);
    expect(reply.result.content[0].text).toBe("called create_presentation");
  });

  it("forwards a read tools/call when writes are off", async () => {
    const h = start();
    h.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_page" } });
    const reply = await h.waitFor((m) => m.id === 6);
    expect(reply.result.content[0].text).toBe("called get_page");
  });

  it("drops a write tools/call sent as a notification", async () => {
    const h = start();
    h.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "create_presentation" } });
    await sentinel(h, "after-notification");
    expect(h.childReceivedAny((m) => m?.method === "tools/call")).toBe(false);
  });

  it("cannot be bypassed with a JSON-RPC batch", async () => {
    const h = start();
    h.send([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_presentation" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_presentation" } },
    ]);
    const refused = await h.waitFor(
      (m) => Array.isArray(m) && m.some((r: Msg) => r.id === 1),
      "batch refusal",
    );
    expect(refused).toHaveLength(1);
    expect((refused as unknown as Msg[])[0]).toMatchObject({ id: 1, error: { code: -32602 } });
    const forwarded = await h.childReceived((m) => Array.isArray(m));
    expect(forwarded).toEqual([
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_presentation" } },
    ]);
  });
});

describe("startProxy: notifications", () => {
  it("forwards client notifications to the child verbatim", async () => {
    const h = start();
    const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
    const roots = { jsonrpc: "2.0", method: "notifications/roots/list_changed", params: { x: [1, "two"] } };
    h.send(initialized);
    h.send(roots);
    expect(await h.childReceived((m) => m.method === "notifications/initialized")).toEqual(initialized);
    expect(await h.childReceived((m) => m.method === "notifications/roots/list_changed")).toEqual(roots);
  });

  it("forwards server notifications and server-to-client requests, and the client's reply back", async () => {
    const h = start();
    const listChanged = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
    const progress = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "p1", progress: 1, total: 2 },
    };
    const sampling = {
      jsonrpc: "2.0",
      id: "s-1",
      method: "sampling/createMessage",
      params: { messages: [], maxTokens: 1 },
    };
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "fake/emit",
      params: { chunks: [listChanged, progress, sampling].map((m) => JSON.stringify(m) + "\n") },
    });
    expect(await h.waitFor((m) => m.method === "notifications/tools/list_changed")).toEqual(listChanged);
    expect(await h.waitFor((m) => m.method === "notifications/progress")).toEqual(progress);
    expect(await h.waitFor((m) => m.method === "sampling/createMessage")).toEqual(sampling);

    const clientReply = { jsonrpc: "2.0", id: "s-1", result: { role: "assistant", content: { type: "text", text: "ok" } } };
    h.send(clientReply);
    expect(await h.childReceived((m) => m.id === "s-1" && !("method" in m))).toEqual(clientReply);
  });
});

describe("startProxy: cancellation", () => {
  it("forwards notifications/cancelled and $/cancelRequest for an in-flight request", async () => {
    const h = start();
    h.send({ jsonrpc: "2.0", id: 42, method: "fake/slow" });
    await h.childReceived((m) => m.id === 42);
    const cancelled = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42, reason: "user" } };
    const lsp = { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 42 } };
    h.send(cancelled);
    h.send(lsp);
    expect(await h.childReceived((m) => m.method === "notifications/cancelled")).toEqual(cancelled);
    expect(await h.childReceived((m) => m.method === "$/cancelRequest")).toEqual(lsp);
  });

  it("forwards a server-side cancellation to the client verbatim", async () => {
    const h = start();
    const cancelled = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "s-9" } };
    h.send({ jsonrpc: "2.0", id: 1, method: "fake/emit", params: { chunks: [JSON.stringify(cancelled) + "\n"] } });
    expect(await h.waitFor((m) => m.method === "notifications/cancelled")).toEqual(cancelled);
  });

  it("still filters a tools/list response that arrives after the client cancelled it", async () => {
    const h = start();
    h.sendRaw(
      JSON.stringify({ jsonrpc: "2.0", id: 50, method: "tools/list" }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 50 } }) +
        "\n",
    );
    const late = await h.waitFor((m) => m.id === 50 && "result" in m);
    expect(late.result.tools.map((t: Msg) => t.name)).toEqual(["get_presentation"]);
  });
});

describe("startProxy: child lifecycle and signals", () => {
  it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)("forwards %s to the child and exits with its code", async (signal) => {
    const h = start({ env: { FAKE_SIGNAL_EXIT_CODE: "0" } });
    await sentinel(h, "up");
    h.signals.emit(signal);
    const seen = await h.waitFor((m) => m.method === "fake/signal");
    expect(seen.params.signal).toBe(signal);
    expect(await h.proxy.exited).toBe(0);
    expect(h.signals.listenerCount(signal)).toBe(0);
  });

  it("escalates to SIGKILL when the child ignores the signal", async () => {
    const h = start({ env: { FAKE_IGNORE_SIGNALS: "1" }, killTimeoutMs: 200 });
    await sentinel(h, "up");
    h.signals.emit("SIGTERM");
    await h.waitFor((m) => m.method === "fake/signal");
    expect(await h.proxy.exited).toBe(137);
    expect(h.proxy.child.signalCode).toBe("SIGKILL");
  });

  it("closes the child's stdin on client EOF, delivers its last output, then exits with its code", async () => {
    const h = start({ env: { FAKE_EOF_EXIT_CODE: "3" } });
    await sentinel(h, "up");
    h.input.end();
    expect(await h.proxy.exited).toBe(3);
    expect(h.messages).toContainEqual({ jsonrpc: "2.0", method: "fake/stdin-end" });
  });

  it("exits with the child's code when the child exits on its own", async () => {
    const h = start();
    await sentinel(h, "up");
    h.send({ jsonrpc: "2.0", method: "fake/exit", params: { code: 5 } });
    expect(await h.proxy.exited).toBe(5);
  });

  it("terminates the child when the client's end of the pipe goes away", async () => {
    const h = start({ env: { FAKE_SIGNAL_EXIT_CODE: "7" } });
    await sentinel(h, "up");
    h.output.destroy(new Error("write EPIPE"));
    expect(await h.proxy.exited).toBe(7);
  });

  it("exits 127 and says why when the server command cannot start", async () => {
    const h = start({ command: "/nonexistent/mcp-write-gate-proxy-test-binary", args: [] });
    expect(await h.proxy.exited).toBe(127);
    expect(h.logs.join("\n")).toContain("/nonexistent/mcp-write-gate-proxy-test-binary");
  });
});
