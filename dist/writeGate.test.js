import { describe, expect, it } from "vitest";
import { createWriteGate } from "./writeGate.js";
describe("createWriteGate", () => {
    const WRITE_TOOLS = new Set([
        "bing_ads_update_campaign",
        "bing_ads_pause_keyword",
        "bing_ads_create_ad_group",
    ]);
    const gate = createWriteGate({
        writeTools: WRITE_TOOLS,
        envPrefix: "BING_ADS",
    });
    describe("isWriteTool", () => {
        it("returns true for write tools", () => {
            expect(gate.isWriteTool("bing_ads_update_campaign")).toBe(true);
            expect(gate.isWriteTool("bing_ads_pause_keyword")).toBe(true);
        });
        it("returns false for non-write tools", () => {
            expect(gate.isWriteTool("bing_ads_list_campaigns")).toBe(false);
            expect(gate.isWriteTool("bing_ads_get_performance")).toBe(false);
        });
    });
    describe("isWriteEnabled", () => {
        it("returns true when env var is set to 'true'", () => {
            const env = { BING_ADS_MCP_WRITE: "true" };
            expect(gate.isWriteEnabled(env)).toBe(true);
        });
        it("returns false when env var is not set", () => {
            const env = {};
            expect(gate.isWriteEnabled(env)).toBe(false);
        });
        it("returns false when env var is set to any value other than 'true'", () => {
            expect(gate.isWriteEnabled({ BING_ADS_MCP_WRITE: "1" })).toBe(false);
            expect(gate.isWriteEnabled({ BING_ADS_MCP_WRITE: "yes" })).toBe(false);
            expect(gate.isWriteEnabled({ BING_ADS_MCP_WRITE: "false" })).toBe(false);
        });
    });
    describe("filterTools", () => {
        const mockTools = [
            {
                name: "bing_ads_update_campaign",
                description: "Update campaign",
                inputSchema: { type: "object" },
            },
            {
                name: "bing_ads_list_campaigns",
                description: "List campaigns",
                inputSchema: { type: "object" },
            },
            {
                name: "bing_ads_pause_keyword",
                description: "Pause keyword",
                inputSchema: { type: "object" },
            },
            {
                name: "bing_ads_get_performance",
                description: "Get performance",
                inputSchema: { type: "object" },
            },
        ];
        it("returns all tools when write is enabled", () => {
            const env = { BING_ADS_MCP_WRITE: "true" };
            const filtered = gate.filterTools(mockTools, env);
            expect(filtered).toHaveLength(4);
        });
        it("filters out write tools when write is disabled", () => {
            const env = { BING_ADS_MCP_WRITE: "false" };
            const filtered = gate.filterTools(mockTools, env);
            expect(filtered).toHaveLength(2);
            expect(filtered.map((t) => t.name)).toEqual([
                "bing_ads_list_campaigns",
                "bing_ads_get_performance",
            ]);
        });
    });
    describe("assertWriteAllowed", () => {
        it("throws when write tool is called with write disabled", () => {
            const env = {};
            expect(() => gate.assertWriteAllowed("bing_ads_update_campaign", env)).toThrow(/BING_ADS_MCP_WRITE=true/);
        });
        it("does not throw for read tools even when write disabled", () => {
            const env = {};
            expect(() => gate.assertWriteAllowed("bing_ads_list_campaigns", env)).not.toThrow();
        });
        it("does not throw for write tools when write enabled", () => {
            const env = { BING_ADS_MCP_WRITE: "true" };
            expect(() => gate.assertWriteAllowed("bing_ads_update_campaign", env)).not.toThrow();
        });
    });
});
//# sourceMappingURL=writeGate.test.js.map