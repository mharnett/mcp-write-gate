#!/usr/bin/env node
/**
 * Assert that this repo has no `NPM_TOKEN` Actions secret.
 *
 * WHY THIS IS NOT A TEST. It was one — src/githubSecrets.test.ts, run by
 * `npm run test:run`, which is what CI runs. It cannot pass there:
 *
 *   1. `gh` in a workflow needs GH_TOKEN in the environment, and the CI job
 *      sets none, so the call dies before it reads anything:
 *        gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN
 *        environment variable.
 *   2. Setting `GH_TOKEN: ${{ github.token }}` does not fix it. Listing a
 *      repo's Actions secrets requires admin, and the workflow `permissions:`
 *      key has no scope that grants it — there is no `secrets: read`. The
 *      default token would 403 where it used to fail on step 1.
 *
 * The only way to make the old test pass in CI is to put an admin-scoped PAT
 * in this repo's Actions secrets — adding a high-privilege credential in
 * order to check that a low-privilege one is absent, and widening exactly the
 * blast radius the deletion narrowed. So the check moved here instead.
 *
 * NO AUTOMATED TRIGGER, stated rather than implied: nothing runs this on a
 * schedule or in CI. It is a manual check (`npm run verify:secrets`) against
 * whatever `gh` credential the operator already holds. If NPM_TOKEN is ever
 * re-added, nothing here notices — that gap is real and is the deliberate
 * trade against the PAT above.
 *
 * Exit 0 absent, 1 present, 2 could not tell.
 */
import { execFileSync } from "node:child_process";
import { listsSecret } from "../dist/secretList.js";

const REPO = "mharnett/mcp-write-gate";
const SECRET = "NPM_TOKEN";

let output;
try {
  output = execFileSync("gh", ["secret", "list", "--repo", REPO], {
    encoding: "utf-8",
  });
} catch (err) {
  // Exit 2, not 1: "I could not look" must not read as "it is absent", and it
  // must not read as "it is present" either.
  console.error(
    `UNKNOWN: could not list secrets for ${REPO}.\n` +
      `${err.stderr || err.message}\n` +
      `Needs a gh credential with admin on the repo. This check is manual; ` +
      `see the header of ${import.meta.url.split("/").pop()}.`,
  );
  process.exit(2);
}

if (listsSecret(output, SECRET)) {
  console.error(`FAIL: ${REPO} still has an Actions secret named ${SECRET}.`);
  console.error(`Remove it:  gh secret delete ${SECRET} --repo ${REPO}`);
  process.exit(1);
}

console.log(`OK: ${REPO} has no Actions secret named ${SECRET}.`);
