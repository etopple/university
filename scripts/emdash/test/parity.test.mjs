import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, extract, compareText, normPath } from "../parity.mjs";

const page = (title, body, links = "") => `<!doctype html><html><head><title>${title}</title></head><body><nav>Sidebar ${links}</nav><main><h1>${title}</h1>${body}<footer>Last updated today</footer></main></body></html>`;

function serve(routes) {
  return new Promise((res) => {
    const s = createServer((req, rsp) => {
      const r = routes[req.url.replace(/\/$/, "") || "/"];
      if (!r) return rsp.writeHead(404, { "content-type": "text/html" }).end(page("Not found", "<p>404</p>"));
      if (r.redirect) return rsp.writeHead(301, { location: r.redirect }).end();
      rsp.writeHead(200, { "content-type": r.type || "text/html" }).end(r.body);
    }).listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }));
  });
}

test("normalisation helpers", () => {
  assert.equal(normPath("/a/b/"), "/a/b");
  assert.equal(normPath("/"), "/");
  assert.equal(normPath("/x%20y/"), "/x y");
  const ex = extract(page("T", "<p>Press <b>Win</b>, then <a href='/x'>go</a>.</p><pre><code><div>a&amp;b</div></code></pre>"), "main", "footer,nav");
  assert.equal(ex.text, "T Press Win, then go. a&b");
  assert.equal(compareText("a b c", "a b c").ratio, 1);
  assert.ok(compareText("a b c d", "a b x d").ratio < 1);
});

test("identical sites pass", async () => {
  const routes = { "/": { body: page("Home", "<p>Hi</p>", "<a href='/a/'>A</a>") }, "/a": { body: page("A", "<p>Alpha</p><img src='/i.png'>") }, "/i.png": { type: "image/png", body: "PNG" } };
  const [b, c] = await Promise.all([serve(routes), serve(routes)]);
  try {
    const { summary } = await run({ base: b.url, candidate: c.url, selector: "main", ignore: "footer,nav,script,style", concurrency: 2, limit: 0, headers: {}, assets: true, out: mkdtempSync(join(tmpdir(), "par-")), seedPaths: false });
    assert.equal(summary.pass, true);
    assert.equal(summary.pages >= 2, true);
    assert.equal(summary.assets, 1);
  } finally {
    b.close();
    c.close();
  }
});

test("text change, missing asset and moved page fail the gate; move gets a redirect suggestion", async () => {
  const base = {
    "/": { body: page("Home", "<p>Hi</p>", "<a href='/a/'>A</a> <a href='/old/'>Old</a>") },
    "/a": { body: page("A", "<p>Alpha</p><img src='/i.png'>") },
    "/old": { body: page("Moved page", "<p>Same</p>") },
    "/i.png": { type: "image/png", body: "PNG" },
  };
  const cand = {
    "/": { body: page("Home", "<p>Hi</p>", "<a href='/a/'>A</a> <a href='/new/'>New</a>") },
    "/a": { body: page("A", "<p>Alpha changed</p><img src='/i.png'>") },
    "/new": { body: page("Moved page", "<p>Same</p>") },
  };
  const [b, c] = await Promise.all([serve(base), serve(cand)]);
  try {
    const { summary, failed } = await run({ base: b.url, candidate: c.url, selector: "main", ignore: "footer,nav", concurrency: 2, limit: 0, headers: {}, assets: true, out: mkdtempSync(join(tmpdir(), "par-")), seedPaths: false });
    assert.equal(summary.pass, false);
    const byUrl = Object.fromEntries(failed.map((f) => [f.url, f]));
    assert.match(byUrl["/a"].problems.join(), /body text differs/);
    assert.match(byUrl["/i.png"].problems.join(), /status 200 -> 404/);
    assert.match(byUrl["/old"].problems.join(), /status 200 -> 404/);
    assert.equal(byUrl["/old"].suggestedRedirect, "/new");
    assert.equal(summary.movedUrls, 1);
  } finally {
    b.close();
    c.close();
  }
});
