import { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface WriteGateConfig {
  writeTools: ReadonlySet<string>;
  envPrefix: string; // e.g. "BING_ADS" → checks BING_ADS_MCP_WRITE
}

export function createWriteGate(config: WriteGateConfig) {
  const envVarName = `${config.envPrefix}_MCP_WRITE`;

  return {
    isWriteTool(toolName: string): boolean {
      return config.writeTools.has(toolName);
    },

    isWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
      return env[envVarName] === "true";
    },

    filterTools(tools: Tool[], env: NodeJS.ProcessEnv = process.env): Tool[] {
      if (this.isWriteEnabled(env)) {
        return tools;
      }
      return tools.filter((tool) => !this.isWriteTool(tool.name));
    },

    assertWriteAllowed(toolName: string, env: NodeJS.ProcessEnv = process.env): void {
      if (this.isWriteTool(toolName) && !this.isWriteEnabled(env)) {
        throw new Error(
          `Write operation not allowed: set ${envVarName}=true to enable write operations`,
        );
      }
    },
  };
}

export type WriteGate = ReturnType<typeof createWriteGate>;
