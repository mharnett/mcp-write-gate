import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("GitHub Actions Secrets", () => {
  it("should not have NPM_TOKEN secret configured", () => {
    const output = execSync("gh secret list --repo mharnett/mcp-write-gate", {
      encoding: "utf-8",
    });

    // The secret list output has format: SECRET_NAME  UPDATED_AT
    // If NPM_TOKEN exists, it will be a line starting with "NPM_TOKEN"
    const lines = output.split("\n").filter((line) => line.trim());
    const hasNpmToken = lines.some((line) => line.startsWith("NPM_TOKEN"));

    expect(hasNpmToken).toBe(false);
  });
});
