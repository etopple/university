// node --test visual-diff.test.mjs   (no browser: argument, naming and baseline-integrity checks only)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { args, readBaseline, writeBaseline, assertUniqueNames, shotName, BASELINE_FILE, THEMES } from "./visual-diff.mjs";

const argv = (...a) => ["node", "visual-diff.mjs", ...a];
const PAGES = [{ path: "/", why: "home" }, { path: "/about-us/values", why: "asides" }];
const fakeShots = (pages) => pages.flatMap((p) => THEMES.map((theme) => ({ path: p.path, theme, buf: Buffer.from(`png ${p.path} ${theme}`) })));
const save = (pages = PAGES) => {
  const dir = join(mkdtempSync(join(tmpdir(), "vd-")), "b");
  const meta = writeBaseline(dir, { source: "https://university.etop.tech", pages, viewport: { width: 1280, height: 900 }, shots: fakeShots(pages) });
  return { dir, meta };
};
const review = (dir, extra = {}) => {
  const f = join(dir, BASELINE_FILE);
  const m = JSON.parse(readFileSync(f, "utf8"));
  writeFileSync(f, JSON.stringify({ ...m, reviewed: { by: "BJ", on: "2026-10-04", manifest: m.manifest, ...extra } }));
};

test("baseline flags: save and compare are separate runs, and --base does not mix in", () => {
  assert.equal(args(argv("--candidate", "https://x/", "--baseline", "b")).baseline, "b");
  assert.throws(() => args(argv("--candidate", "https://x", "--baseline", "b", "--save-baseline", "c")), /separate runs/);
  assert.throws(() => args(argv("--candidate", "https://x", "--baseline", "b", "--base", "https://y")), /--base is not used/);
  assert.equal(args(argv("--candidate", "https://x/")).candidate, "https://x");
});

test("shot names never collide: / vs /home, /a/b vs /a__b vs /a-b", () => {
  const names = ["/", "/home", "/a/b", "/a__b", "/a-b", "/a/b/"].map((p) => shotName(p, "light"));
  assert.equal(new Set(names).size, names.length);
  assert.match(shotName("/about-us/values", "dark"), /^about-us-values-[0-9a-f]{10}-dark$/);
  assert.equal(shotName("/x", "light"), shotName("/x", "light")); // stable between save and compare
  // The same page listed twice is caught before anything is written.
  assert.throws(() => assertUniqueNames([{ path: "/a" }, { path: "/a" }]), /would both be saved/);
  const dir = join(mkdtempSync(join(tmpdir(), "vd-")), "b");
  assert.throws(() => writeBaseline(dir, { source: "s", pages: [{ path: "/a" }, { path: "/a" }], viewport: {}, shots: [] }), /would both be saved/);
});

test("clean round-trip: save, review with the manifest hash, read back", () => {
  const { dir, meta } = save();
  assert.equal(meta.files.length, 4);
  assert.throws(() => readBaseline(dir), /not reviewed/);
  assert.equal(readBaseline(dir, { allowUnreviewed: true }).isReviewed, false);
  review(dir);
  const b = readBaseline(dir);
  assert.equal(b.isReviewed, true);
  assert.equal(readFileSync(join(dir, b.fileFor("/about-us/values", "dark")), "utf8"), "png /about-us/values dark");
  // Saving into the same folder again is refused.
  assert.throws(() => writeBaseline(dir, { source: "s", pages: PAGES, viewport: {}, shots: fakeShots(PAGES) }), /never overwritten/);
});

test("a review without the manifest hash, or with another one, is refused", () => {
  const { dir } = save();
  review(dir, { manifest: undefined });
  assert.throws(() => readBaseline(dir), /reviewed\.manifest/);
  review(dir, { manifest: "0".repeat(64) });
  assert.throws(() => readBaseline(dir), /reviewed\.manifest/);
  review(dir, { by: "  " }); // a blank name is not a review
  assert.throws(() => readBaseline(dir), /not reviewed/);
});

test("swapped, edited, extra or missing PNGs are refused, even with --allow-unreviewed", () => {
  const swap = save();
  review(swap.dir);
  const [a, b] = swap.meta.files;
  renameSync(join(swap.dir, a.file), join(swap.dir, "tmp.bin"));
  renameSync(join(swap.dir, b.file), join(swap.dir, a.file));
  renameSync(join(swap.dir, "tmp.bin"), join(swap.dir, b.file));
  assert.throws(() => readBaseline(swap.dir), /changed since the baseline was saved/);
  assert.throws(() => readBaseline(swap.dir, { allowUnreviewed: true }), /changed since/);

  const extra = save();
  review(extra.dir);
  writeFileSync(join(extra.dir, "sneaky-light.png"), "x");
  assert.throws(() => readBaseline(extra.dir), /not in the manifest: sneaky-light\.png/);

  const gone = save();
  review(gone.dir);
  renameSync(join(gone.dir, gone.meta.files[0].file), join(gone.dir, "moved.bak"));
  assert.throws(() => readBaseline(gone.dir), /is missing/);

  // Re-pointing an entry at another file (and fixing the hash list) breaks the manifest hash.
  const edited = save();
  review(edited.dir);
  const f = join(edited.dir, BASELINE_FILE);
  const m = JSON.parse(readFileSync(f, "utf8"));
  m.files[0] = { ...m.files[0], sha256: m.files[1].sha256, file: m.files[1].file };
  writeFileSync(f, JSON.stringify(m));
  assert.throws(() => readBaseline(edited.dir), /edited after saving/);
});
