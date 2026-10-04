// node --test visual-diff.test.mjs   (no browser: argument and baseline checks only)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { args, readBaseline, baselineMeta, shotName, BASELINE_FILE } from "./visual-diff.mjs";

const argv = (...a) => ["node", "visual-diff.mjs", ...a];

test("baseline flags: save and compare are separate runs, and --base does not mix in", () => {
  assert.equal(args(argv("--candidate", "https://x/", "--baseline", "b")).baseline, "b");
  assert.throws(() => args(argv("--candidate", "https://x", "--baseline", "b", "--save-baseline", "c")), /separate runs/);
  assert.throws(() => args(argv("--candidate", "https://x", "--baseline", "b", "--base", "https://y")), /--base is not used/);
  assert.equal(args(argv("--candidate", "https://x/")).candidate, "https://x");
});

test("an unreviewed baseline is refused unless explicitly allowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "vd-"));
  assert.throws(() => readBaseline(dir), /no baseline\.json/);
  const meta = baselineMeta({ source: "https://university.etop.tech", pages: [{ path: "/", why: "home" }], viewport: { width: 1280, height: 900 } });
  writeFileSync(join(dir, BASELINE_FILE), JSON.stringify(meta));
  assert.throws(() => readBaseline(dir), /not reviewed/);
  assert.equal(readBaseline(dir, { allowUnreviewed: true }).isReviewed, false);
  writeFileSync(join(dir, BASELINE_FILE), JSON.stringify({ ...meta, reviewed: { by: "  ", on: "2026-10-04" } }));
  assert.throws(() => readBaseline(dir), /not reviewed/); // a blank name is not a review
  writeFileSync(join(dir, BASELINE_FILE), JSON.stringify({ ...meta, reviewed: { by: "BJ", on: "2026-10-04" } }));
  assert.equal(readBaseline(dir).isReviewed, true);
});

test("shot names match between save and compare", () => {
  assert.equal(shotName("/", "dark"), "home-dark");
  assert.equal(shotName("/about-us/values", "light"), "about-us__values-light");
});
