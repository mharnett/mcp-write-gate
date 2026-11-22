// A fake MCP stdio server for the write-gate proxy tests.
//
// Containment: no network, no filesystem, no child processes, no imports. It
// reads newline-delimited JSON-RPC on stdin and writes to stdout only.
//
// For every message it receives it first emits
//   {"jsonrpc":"2.0","method":"fake/received","params":{"message":<msg>}}
// so a test can see exactly what reached the child, then answers requests:
//   initialize            -> a minimal server capability result
//   tools/list            -> two pages of tools (read and write mixed)
//   tools/call            -> {"content":[{"type":"text","text":"called <name>"}]}
//   fake/pid              -> {"pid": <this process's pid>}
//   fake/slow             -> never answered (a request left to be cancelled)
//   fake/emit             -> writes params.chunks to stdout verbatim, one
//                            write per chunk, 20 ms apart, then answers {ok:true}
//   fake/exit             -> exits with params.code
//   anything else with id -> {"echo": <method>}
//
// Signals (SIGTERM, SIGINT, SIGHUP) emit {"method":"fake/signal",...} and exit
// with FAKE_SIGNAL_EXIT_CODE (default 0), unless FAKE_IGNORE_SIGNALS=1, in which
// case the process stays up. Stdin EOF emits {"method":"fake/stdin-end"} and
// exits with FAKE_EOF_EXIT_CODE (default 0).

const PAGE_1 = [
  { name: "get_presentation", inputSchema: { type: "object" } },
  { name: "create_presentation", inputSchema: { type: "object" } },
];
const PAGE_2 = [
  { name: "get_page", inputSchema: { type: "object" } },
  { name: "batch_update_presentation", inputSchema: { type: "object" } },
  { name: "summarize_presentation", inputSchema: { type: "object" } },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function stop(code) {
  process.exitCode = code;
  process.stdin.removeAllListeners("data");
  process.stdin.destroy();
}

function answer(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string" || !("id" in msg)) {
    return undefined;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fake-mcp-server", version: "0.0.0" },
        },
      };
    case "tools/list":
      return params?.cursor
        ? { jsonrpc: "2.0", id, result: { tools: PAGE_2 } }
        : { jsonrpc: "2.0", id, result: { tools: PAGE_1, nextCursor: "page-2" } };
    case "tools/call":
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `called ${params?.name}` }] },
      };
    case "fake/pid":
      return { jsonrpc: "2.0", id, result: { pid: process.pid } };
    case "fake/slow":
    case "fake/emit":
    case "fake/exit":
      return undefined;
    default:
      return { jsonrpc: "2.0", id, result: { echo: method } };
  }
}

function emitChunks(chunks, done) {
  let i = 0;
  const next = () => {
    if (i >= chunks.length) return done();
    process.stdout.write(chunks[i++]);
    setTimeout(next, 20);
  };
  next();
}

function handle(msg) {
  send({ jsonrpc: "2.0", method: "fake/received", params: { message: msg } });

  if (Array.isArray(msg)) {
    const replies = msg.map(answer).filter((r) => r !== undefined);
    if (replies.length > 0) send(replies);
    return;
  }
  if (msg?.method === "fake/emit") {
    emitChunks(msg.params?.chunks ?? [], () => {
      if ("id" in msg) send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    });
    return;
  }
  if (msg?.method === "fake/exit") {
    stop(Number(msg.params?.code ?? 0));
    return;
  }
  const reply = answer(msg);
  if (reply !== undefined) send(reply);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let index;
  while ((index = buffer.indexOf(0x0a)) !== -1) {
    const line = buffer.toString("utf8", 0, index).replace(/\r$/, "");
    buffer = buffer.subarray(index + 1);
    if (line.trim() === "") continue;
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  send({ jsonrpc: "2.0", method: "fake/stdin-end" });
  stop(Number(process.env.FAKE_EOF_EXIT_CODE ?? 0));
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    send({ jsonrpc: "2.0", method: "fake/signal", params: { signal } });
    if (process.env.FAKE_IGNORE_SIGNALS !== "1") {
      stop(Number(process.env.FAKE_SIGNAL_EXIT_CODE ?? 0));
    }
  });
}
