import { describe, expect, it } from "vitest";
import { parseProxyArgs, UsageError } from "./proxyArgs.js";

describe("parseProxyArgs", () => {
  it("parses the documented form", () => {
    expect(
      parseProxyArgs([
        "--env-prefix",
        "GOOGLE_SLIDES",
        "--write-tools",
        "create_presentation,batch_update_presentation",
        "--",
        "/path/run-mcp.sh",
      ]),
    ).toEqual({
      envPrefix: "GOOGLE_SLIDES",
      writeTools: ["create_presentation", "batch_update_presentation"],
      killTimeoutMs: 1500,
      command: "/path/run-mcp.sh",
      args: [],
    });
  });

  it("accepts --flag=value, repeated --write-tools, and a kill timeout", () => {
    const parsed = parseProxyArgs([
      "--env-prefix=SLIDES",
      "--write-tools= a , b,",
      "--write-tools",
      "c",
      "--kill-timeout-ms",
      "250",
      "--",
      "node",
      "server.js",
    ]);
    expect(parsed.envPrefix).toBe("SLIDES");
    expect(parsed.writeTools).toEqual(["a", "b", "c"]);
    expect(parsed.killTimeoutMs).toBe(250);
    expect(parsed.command).toBe("node");
    expect(parsed.args).toEqual(["server.js"]);
  });

  it("passes everything after -- to the server untouched, flags included", () => {
    const parsed = parseProxyArgs([
      "--env-prefix",
      "X",
      "--write-tools",
      "w",
      "--",
      "srv",
      "--env-prefix",
      "--",
      "",
    ]);
    expect(parsed.command).toBe("srv");
    expect(parsed.args).toEqual(["--env-prefix", "--", ""]);
  });

  it.each([
    [["--write-tools", "w", "--", "srv"], /--env-prefix/],
    [["--env-prefix", "X", "--", "srv"], /--write-tools/],
    [["--env-prefix", "X", "--write-tools", " , ", "--", "srv"], /--write-tools/],
    [["--env-prefix", "X", "--write-tools", "w"], /command/],
    [["--env-prefix", "X", "--write-tools", "w", "--"], /command/],
    [["--env-prefix", "lower-case", "--write-tools", "w", "--", "srv"], /--env-prefix/],
    [["--env-prefix", "X", "--write-tools", "w", "--bogus", "--", "srv"], /--bogus/],
    [["--env-prefix", "X", "--write-tools", "w", "--kill-timeout-ms", "0", "--", "srv"], /--kill-timeout-ms/],
    [["--env-prefix", "X", "--write-tools", "w", "--kill-timeout-ms", "soon", "--", "srv"], /--kill-timeout-ms/],
    [["--env-prefix"], /--env-prefix/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseProxyArgs(argv)).toThrow(UsageError);
    expect(() => parseProxyArgs(argv)).toThrow(message);
  });
});
