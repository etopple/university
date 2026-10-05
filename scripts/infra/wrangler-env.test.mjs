// node --test scripts/infra/wrangler-env.test.mjs
// Issue #29: `routes` is inheritable in wrangler, so an env without its own `routes` claims the
// production hostnames. Resolve the config the way wrangler does and pin each env's routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";

const config = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
const read = (env) => unstable_readConfig({ config, env }, { hideWarnings: true });
const patterns = (c) => (c.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern)).sort();

test("preview resolves to its own worker with no routes (#29)", () => {
  const c = read("preview");
  assert.equal(c.name, "university-emdash-preview");
  assert.deepEqual(patterns(c), []);
  assert.equal(c.workers_dev, true);
});

test("production keeps exactly the two university hosts", () => {
  const c = read(undefined);
  assert.equal(c.name, "university-emdash");
  assert.deepEqual(patterns(c), ["university.etop.tech/*", "www.university.etop.tech/*"]);
});
