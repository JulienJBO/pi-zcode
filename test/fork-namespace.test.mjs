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

test("base OAuth provider exposes only Start Plan models", () => {
  const entry = read("src/index.ts");
  assert.match(entry, /if \(reg\.plan === ZCodePlan\.START_PLAN\)/);
  assert.match(entry, /models: startPlanModels/);
  assert.doesNotMatch(entry, /allActiveModels/);
});

test("gateway risk-control errors retain upstream status and diagnostic code", () => {
  const stream = read("src/stream/stream.ts");
  const diagnostics = read("src/diagnostics/diagnostics.ts");
  const types = read("src/types/types.ts");
  const entry = read("src/index.ts");
  assert.match(stream, /extractUpstreamErrorCode\(lastErrText\)/);
  assert.match(stream, /code 3012: unusual activity/);
  assert.match(stream, /official ZCode client/);
  assert.match(stream, /setLastUpstreamCode\(undefined\)/);
  assert.match(diagnostics, /export function setLastUpstreamCode/);
  assert.match(types, /upstreamCode\?: number;/);
  assert.match(entry, /upstreamCode: \$\{d\.upstreamCode \?\? "none"\}/);
});
