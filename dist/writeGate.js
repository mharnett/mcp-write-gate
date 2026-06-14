export function createWriteGate(config) {
    const envVarName = `${config.envPrefix}_MCP_WRITE`;
    return {
        isWriteTool(toolName) {
            return config.writeTools.has(toolName);
        },
        isWriteEnabled(env = process.env) {
            return env[envVarName] === "true";
        },
        filterTools(tools, env = process.env) {
            if (this.isWriteEnabled(env)) {
                return Array.from(tools);
            }
            return Array.from(tools).filter((tool) => !this.isWriteTool(tool.name));
        },
        assertWriteAllowed(toolName, env = process.env) {
            if (this.isWriteTool(toolName) && !this.isWriteEnabled(env)) {
                throw new Error(`Write operation not allowed: set ${envVarName}=true to enable write operations`);
            }
        },
    };
}
//# sourceMappingURL=writeGate.js.map