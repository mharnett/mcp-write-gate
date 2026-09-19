/**
 * Parsing for `gh secret list` output.
 *
 * Split out from the check that calls `gh` so the decision — "is this secret
 * configured?" — is testable without a network call, an admin credential, or
 * a `gh` on PATH. The shell-out lives in scripts/verify-no-npm-token.mjs and
 * does nothing but hand its stdout to these two functions.
 */

/** Secret names from `gh secret list` stdout, one per non-blank row. */
export function parseSecretNames(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/)[0]!);
}

/** Whether `name` is configured, matched exactly — never as a prefix. */
export function listsSecret(output: string, name: string): boolean {
  return parseSecretNames(output).includes(name);
}
