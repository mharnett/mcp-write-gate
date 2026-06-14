export interface WriteGateConfig {
    writeTools: ReadonlySet<string>;
    envPrefix: string;
}
export declare function createWriteGate(config: WriteGateConfig): {
    isWriteTool(toolName: string): boolean;
    isWriteEnabled(env?: NodeJS.ProcessEnv): boolean;
    filterTools<T extends {
        name: string;
    }>(tools: readonly T[], env?: NodeJS.ProcessEnv): T[];
    assertWriteAllowed(toolName: string, env?: NodeJS.ProcessEnv): void;
};
export type WriteGate = ReturnType<typeof createWriteGate>;
//# sourceMappingURL=writeGate.d.ts.map