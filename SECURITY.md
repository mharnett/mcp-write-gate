# Security policy

mcp-write-gate is the write gate that Model Context Protocol (MCP) servers can build on, plus a proxy that puts the same gate in front of a server with none of its own. I maintain it on my own. If you find a way around the gate, or a way to make the proxy leak a credential, please tell me privately.

## Reporting a problem

Please keep the details out of public issues, pull requests and discussions.

- If this repo's **Security** tab shows a **Report a vulnerability** button, use it. That report is private.
- If there's no button, open an issue that asks for a private contact and says nothing else about the problem.

In the private report, the useful details are the version, whether it's the library or the proxy, the smallest steps that show the problem and what someone could do with it. Please use made-up account ids, and leave out real tokens and account data.

## In scope

- **Write-gate bypass.** While a server's write switch (`<PREFIX>_MCP_WRITE`) is off, the tools on its write list are left out of the tool list and refused if called. A way for a listed tool to show up or run anyway, through the library or the proxy, is in scope.
- **Credential leakage.** The proxy passes its environment to the server it starts. A way for that environment, or the contents of a message, to end up in the proxy's log or anywhere other than the client and the server is in scope.

PAUSED staging is out of scope here: the gate decides whether a write tool runs, and each server decides what that tool creates.

## What I assume

- **A single-user Mac.** I build this for one person running it on their own Mac, or on another computer only they use. Anyone able to run programs under your account can turn writes on. The gate is there to stop accidental changes, not someone with that access.
- **Your own platform credentials.** The gate has none of its own and doesn't limit the login behind a server: a leaked token or key works without it. If you only need to read, a read-only login is the stronger limit.
- **Your own write list.** The gate covers the tools it's told about. A write tool that a server leaves off its list isn't gated, so report that to the server.
