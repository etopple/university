// node --test visual-diff.test.mjs   (no browser: argument, naming and baseline-integrity checks only)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { args, readBaseline, writeBaseline, assertUniqueNames, shotName, manifestHash, BASELINE_FILE, THEMES } from "./visual-diff.mjs";

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

// Rewrite baseline.json as a determined editor would: recompute the manifest hash and sign it.
const forge = (dir, mutate) => {
  const f = join(dir, BASELINE_FILE);
  const m = JSON.parse(readFileSync(f, "utf8"));
  mutate(m);
  m.manifest = manifestHash(m.files, m.pages);
  m.reviewed = { by: "BJ", on: "2026-10-04", manifest: m.manifest };
  writeFileSync(f, JSON.stringify(m));
};

test("manifest file names cannot leave the baseline folder or be anything but a shot name", () => {
  for (const bad of ["../outside.png", "..\\outside.png", "x\\home-8a5edab282-light.png","sub/x.png", "C:x.png", "C:/x.png", "x.png", "home-8a5edab282-light.PNG"]) {
    const { dir } = save();
    forge(dir, (m) => { m.files[0].file = bad; });
    assert.throws(() => readBaseline(dir), /not a valid shot file name|outside the baseline/, bad);
    assert.throws(() => readBaseline(dir, { allowUnreviewed: true }), /not a valid shot file name|outside the baseline/, bad);
  }
  // A valid-looking name for ANOTHER page is refused too.
  const { dir, meta } = save();
  forge(dir, (m) => { m.files[0].file = meta.files.find((f) => f.path !== m.files[0].path).file; });
  assert.throws(() => readBaseline(dir), /not a valid shot file name|more than one shot|twice/);
});

test("coverage cannot shrink and stay reviewed: pages are in the hash, shots must match pages one to one", () => {
  const pages3 = [...PAGES, { path: "/team/meet-the-team", why: "photos" }];
  const a = save(pages3), b = save(PAGES);
  // Same shots for the shared pages, but a different page list => a different hash.
  assert.notEqual(manifestHash(a.meta.files.filter((f) => f.path !== "/team/meet-the-team"), pages3), manifestHash(b.meta.files, PAGES));
  // Dropping a page and its shots after review breaks the reviewed hash.
  const { dir } = save(pages3);
  review(dir);
  const f = join(dir, BASELINE_FILE);
  const m = JSON.parse(readFileSync(f, "utf8"));
  const gone = m.files.filter((x) => x.path === "/team/meet-the-team");
  m.pages = m.pages.filter((p) => p.path !== "/team/meet-the-team");
  m.files = m.files.filter((x) => x.path !== "/team/meet-the-team");
  m.manifest = manifestHash(m.files, m.pages); // reviewed.manifest still holds the old hash
  writeFileSync(f, JSON.stringify(m));
  for (const g of gone) renameSync(join(dir, g.file), join(dir, g.file + ".bak"));
  assert.throws(() => readBaseline(dir), /reviewed\.manifest/);
  // A page listed without its shots, or a shot for an unlisted page, is refused even when re-signed.
  const c = save();
  forge(c.dir, (x) => { x.files = x.files.filter((y) => !(y.path === "/" && y.theme === "dark")); });
  renameSync(join(c.dir, shotName("/", "dark") + ".png"), join(c.dir, "dark.bak"));
  assert.throws(() => readBaseline(c.dir), /no screenshot for dark \//);
  const d = save();
  forge(d.dir, (x) => { x.pages = x.pages.filter((p) => p.path !== "/"); });
  assert.throws(() => readBaseline(d.dir), /not in the page list/);
});

test("saving refuses a folder that already exists, even an empty one", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "vd-")), "b");
  mkdirSync(dir);
  assert.throws(() => writeBaseline(dir, { source: "s", pages: PAGES, viewport: {}, shots: fakeShots(PAGES) }), /already exists/);
});
