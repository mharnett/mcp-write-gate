import { describe, expect, it } from "vitest";
import { listsSecret, parseSecretNames } from "./secretList.js";

describe("parseSecretNames", () => {
  it("reads the name out of each `gh secret list` row", () => {
    const output = [
      "NPM_TOKEN\t2026-09-18T04:11:02Z",
      "SLACK_WEBHOOK\t2026-08-02T17:40:55Z",
    ].join("\n");
    expect(parseSecretNames(output)).toEqual(["NPM_TOKEN", "SLACK_WEBHOOK"]);
  });

  it("is empty for a repo with no secrets", () => {
    // What `gh secret list` actually prints here today: nothing at all.
    expect(parseSecretNames("")).toEqual([]);
    expect(parseSecretNames("\n\n")).toEqual([]);
  });

  it("tolerates space-separated columns and a trailing newline", () => {
    expect(parseSecretNames("NPM_TOKEN  2026-09-18T04:11:02Z\n")).toEqual([
      "NPM_TOKEN",
    ]);
  });
});

describe("listsSecret", () => {
  it("finds an exact name", () => {
    expect(listsSecret("NPM_TOKEN\t2026-09-18T04:11:02Z", "NPM_TOKEN")).toBe(
      true,
    );
  });

  it("is false when the repo has no secrets", () => {
    expect(listsSecret("", "NPM_TOKEN")).toBe(false);
  });

  // The regression that makes this worth extracting from the shell-out at
  // all: the original check was `line.startsWith("NPM_TOKEN")`, which reports
  // a DIFFERENT secret as the one it is looking for. Deleting NPM_TOKEN while
  // NPM_TOKEN_READONLY remained would have left the check red with nothing
  // left to delete.
  it("does not match a longer secret that merely starts with the name", () => {
    expect(listsSecret("NPM_TOKEN_READONLY\t2026-09-18T04:11:02Z", "NPM_TOKEN"))
      .toBe(false);
  });

  it("does not match a secret that merely contains the name", () => {
    expect(listsSecret("OLD_NPM_TOKEN\t2026-09-18T04:11:02Z", "NPM_TOKEN")).toBe(
      false,
    );
  });
});
