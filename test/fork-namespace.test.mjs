import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("provider registry namespace is disjoint", () => {
  const models = read("src/models/models.ts");
  for (const name of ["zcode-cloud", "zcode-cloud-start-plan", "zcode-cloud-individual-plan"]) {
    assert.ok(models.includes(`= "${name}"`));
  }
  assert.doesNotMatch(models, /PROVIDER_ID = "zcode";/);
});

test("login and credential storage are isolated", () => {
  const credentials = read("src/auth/credentials.ts");
  assert.match(credentials, /readStoredCredential\(PROVIDER_ID\)/);
  assert.doesNotMatch(credentials, /readStoredCredential\("zcode"\)/);
  assert.match(read("src/index.ts"), /setStoredZCodeCredentials\(parsed\)/);
  assert.match(read("src/index.ts"), /parseApiKey\(getZCodeApiKey\(creds\)\)/);
});

test("custom transport and individual plan routing stay isolated", () => {
  assert.match(read("src/types/types.ts"), /"zcode-cloud-stream"/);
  assert.match(read("src/stream/stream.ts"), /model\.provider === PROVIDER_ID_INDIVIDUAL_PLAN/);
  const stream = read("src/stream/stream.ts");
  assert.match(stream, /readStoredZCodeCredentials\(true\)/);
  assert.match(stream, /model\.provider === PROVIDER_ID_START_PLAN/);
  assert.match(stream, /model\.provider === PROVIDER_ID_INDIVIDUAL_PLAN/);
  const index = read("src/index.ts");
  assert.match(index, /message\.provider !== PROVIDER_ID_START_PLAN/);
  assert.match(index, /message\.provider !== PROVIDER_ID_INDIVIDUAL_PLAN/);
});

test("commands and package identity do not collide", () => {
  const index = read("src/index.ts");
  assert.match(index, /registerCommand\("zcode-cloud\.doctor"/);
  assert.match(index, /registerCommand\("zcode-cloud\.usage"/);
  assert.doesNotMatch(index, /registerCommand\("zcode\.(doctor|usage)"/);
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(pkg.name, "pi-zcode-cloud");
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.equal(lock.version, pkg.version);
});

test("plan-specific providers are selectable without copying OAuth tokens", () => {
  const entry = read("src/index.ts");
  const credentials = read("src/auth/credentials.ts");
  const stream = read("src/stream/stream.ts");
  assert.match(entry, /apiKey: LINKED_PLAN_API_KEY_MARKER/);
  assert.match(credentials, /LINKED_PLAN_API_KEY_MARKER = "pi-zcode-cloud-linked-oauth"/);
  assert.match(stream, /const auth = linkedPlan[\s\S]*readStoredZCodeCredentials\(true\)/);
  assert.doesNotMatch(stream, /readStoredZCodeCredentials\(\) \?\? auth/);
  assert.match(entry, /getProviderAuthStatus\(id\)/);
  assert.match(entry, /getAvailable\(\)/);
});
