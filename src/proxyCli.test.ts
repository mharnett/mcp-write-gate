import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LineBuffer } from "./proxy.js";

// End to end through the built bin, the same file `.claude.json` will run.
// Containment: the proxy's child is `node test/fixtures/fakeMcpServer.mjs`
// (no imports, stdin/stdout only). No network, no Keychain, no real server.
const BIN = fileURLToPath(new URL("../dist/proxyCli.js", import.meta.url));
const FAKE_SERVER = fileURLToPath(new URL("../test/fixtures/fakeMcpServer.mjs", import.meta.url));
const ENV_VAR = "FAKE_SLIDES_MCP_WRITE";

type Msg = Record<string, any>;

interface Bin {
  proc: ChildProcessWithoutNullStreams;
  messages: Msg[];
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  send(msg: unknown): void;
  waitFor(pred: (m: Msg) => boolean, label?: string): Promise<Msg>;
}

const procs: ChildProcessWithoutNullStreams[] = [];
const childPids: number[] = [];

function runBin(extraEnv: Record<string, string> = {}, argv?: string[]): Bin {
  if (!existsSync(BIN)) throw new Error(`${BIN} is missing: run \`npm run build\` first`);
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (!(ENV_VAR in extraEnv)) delete env[ENV_VAR];
  const proc = spawn(
    process.execPath,
    [
      BIN,
      ...(argv ?? [
        "--env-prefix",
        "FAKE_SLIDES",
        "--write-tools",
        "create_presentation,batch_update_presentation",
        "--kill-timeout-ms",
        "300",
        "--",
        process.execPath,
        FAKE_SERVER,
      ]),
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  procs.push(proc);
  const messages: Msg[] = [];
  const waiters: Array<() => void> = [];
  let err = "";
  const reader = new LineBuffer();
  proc.stdout.on("data", (chunk: Buffer) => {
    for (const line of reader.push(chunk)) messages.push(JSON.parse(line));
    for (const w of waiters.splice(0)) w();
  });
  proc.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.on("close", (code, signal) => resolve({ code, signal })),
  );
  return {
    proc,
    messages,
    stderr: () => err,
    exited,
    send: (msg) => proc.stdin.write(JSON.stringify(msg) + "\n"),
    waitFor(pred, label = "message") {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}; got ${JSON.stringify(messages)}; stderr ${err}`)),
          3000,
        );
        const check = () => {
          const hit = messages.find(pred);
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
  };
}

async function childPid(bin: Bin): Promise<number> {
  bin.send({ jsonrpc: "2.0", id: "pid", method: "fake/pid" });
  const reply = await bin.waitFor((m) => m.id === "pid" && "result" in m, "child pid");
  childPids.push(reply.result.pid);
  return reply.result.pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const p of procs.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  for (const pid of childPids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
});

describe("mcp-write-gate-proxy bin", () => {
  it("hides and refuses write tools end to end", async () => {
    const bin = runBin();
    bin.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const list = await bin.waitFor((m) => m.id === 1);
    expect(list.result.tools.map((t: Msg) => t.name)).toEqual(["get_presentation"]);

    bin.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_presentation" } });
    const refused = await bin.waitFor((m) => m.id === 2);
    expect(refused.error.message).toContain(`${ENV_VAR}=true`);
  });

  it("allows write tools end to end when the opt-in env var is set", async () => {
    const bin = runBin({ [ENV_VAR]: "true" });
    bin.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_presentation" } });
    const reply = await bin.waitFor((m) => m.id === 2);
    expect(reply.result.content[0].text).toBe("called create_presentation");
  });

  it("forwards SIGTERM sent to the proxy process, then exits after the child", async () => {
    const bin = runBin();
    const pid = await childPid(bin);
    bin.proc.kill("SIGTERM");
    const seen = await bin.waitFor((m) => m.method === "fake/signal");
    expect(seen.params.signal).toBe("SIGTERM");
    expect(await bin.exited).toEqual({ code: 0, signal: null });
    expect(alive(pid)).toBe(false);
  });

  it("kills a child that ignores SIGTERM and leaves no process behind", async () => {
    const bin = runBin({ FAKE_IGNORE_SIGNALS: "1" });
    const pid = await childPid(bin);
    bin.proc.kill("SIGTERM");
    await bin.waitFor((m) => m.method === "fake/signal");
    expect(await bin.exited).toEqual({ code: 137, signal: null });
    expect(alive(pid)).toBe(false);
  });

  it("exits with the child's code after the client closes stdin", async () => {
    const bin = runBin({ FAKE_EOF_EXIT_CODE: "3" });
    await childPid(bin);
    bin.proc.stdin.end();
    expect(await bin.exited).toEqual({ code: 3, signal: null });
    expect(bin.messages).toContainEqual({ jsonrpc: "2.0", method: "fake/stdin-end" });
  });

  it("exits 2 with usage on bad arguments, without starting anything", async () => {
    const bin = runBin({}, ["--write-tools", "w", "--", process.execPath, FAKE_SERVER]);
    expect(await bin.exited).toEqual({ code: 2, signal: null });
    expect(bin.stderr()).toContain("--env-prefix");
    expect(bin.stderr()).toContain("Usage:");
  });
});
