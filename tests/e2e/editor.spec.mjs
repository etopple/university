// Editor E2E: sign in, edit the test page in the EmDash editor, publish it,
// and confirm a visitor sees the change. Run against `astro dev` (dev-bypass)
// or the Access-protected preview (service token + EmDash API token).
// Setup and env vars: tests/e2e/README.md.

import { test, expect } from "@playwright/test";
import { AUTH, BASE_URL, COLLECTION, TEST_SLUG, accessHeaders, api, editorHeaders, findBySlug, requireConfig } from "./lib/env.mjs";

const PUBLISH_API = /\/_emdash\/api\/content\/docs\/[^/]+\/publish$/;

test.beforeAll(() => requireConfig());

test("editor: edit the test page, publish, and the change is live", async ({ browser }) => {
  // ---- 1. Sign in ---------------------------------------------------------
  const editor = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: editorHeaders() });
  const page = await editor.newPage();

  if (AUTH === "dev-bypass") {
    await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/api/auth/me");
    await page.waitForURL((u) => u.pathname === "/_emdash/api/auth/me", { timeout: 30_000 });
    // Clear the first-login welcome modal before the admin shell loads.
    const r = await page.request.post("/_emdash/api/auth/me", { headers: { "X-EmDash-Request": "1" }, data: { action: "dismissWelcome" } });
    expect(r.status(), "dismiss welcome modal").toBe(200);
  } else {
    const me = await page.request.get("/_emdash/api/auth/me");
    expect(me.status(), "API token rejected: is EMDASH_TOKEN valid with the admin scope?").toBe(200);
  }

  // ---- 2. Make sure the test page exists (unlisted: not in the sidebar menu)
  const call = api(page.request);
  let entry = await findBySlug(call, COLLECTION, TEST_SLUG);
  if (!entry) {
    const created = await call("POST", `/content/${COLLECTION}`, {
      slug: TEST_SLUG,
      data: {
        title: "E2E test page",
        description: "Edited by the automated editor test. Not linked from the sidebar; safe to ignore.",
        body: [
          {
            _type: "block",
            _key: "e2e1",
            style: "normal",
            markDefs: [],
            children: [{ _type: "span", _key: "e2e2", text: "This page exists so the automated test has something to edit.", marks: [] }],
          },
        ],
        template: "doc",
      },
    });
    entry = created.item || created;
    await call("POST", `/content/${COLLECTION}/${entry.id}/publish`, {});
  }

  // ---- 3. Edit in the real editor UI -------------------------------------
  const stamp = `E2E ${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const title = `E2E test page (${stamp})`;

  await page.goto(`/_emdash/admin/content/${COLLECTION}/${entry.id}`);
  await page.waitForSelector('aside[aria-label="Admin navigation"]', { timeout: 30_000 });
  await page.waitForSelector("astro-island:not([ssr])", { timeout: 30_000 });
  const getStarted = page.getByRole("button", { name: "Get Started" });
  if (await getStarted.isVisible({ timeout: 2_000 }).catch(() => false)) await getStarted.click();

  const titleField = page.locator("#field-title");
  await expect(titleField).toBeVisible({ timeout: 15_000 });
  await titleField.fill(title);
  await page.locator('form button[type="submit"]').first().click();
  await expect(page.getByRole("button", { name: "Saved" }).first()).toBeVisible({ timeout: 15_000 });

  // ---- 4. Publish ---------------------------------------------------------
  const published = page.waitForResponse((r) => PUBLISH_API.test(new URL(r.url()).pathname) && r.request().method() === "POST", { timeout: 20_000 });
  await page.getByRole("button", { name: /^Publish (now|changes)$/ }).first().click();
  const confirm = page.getByRole("dialog").getByRole("button", { name: /^Publish (now|changes)$/ });
  if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.click();
  expect((await published).status(), "publish API call").toBe(200);

  // The API agrees the live version carries the new title.
  const after = await call("GET", `/content/${COLLECTION}/${entry.id}`);
  const live = after.item?.liveData || after.item?.data || {};
  expect(live.title).toBe(title);
  await editor.close();

  // ---- 5. A visitor sees it ----------------------------------------------
  // Fresh context, no EmDash credentials: only the Access service token, which
  // the whole preview hostname needs. Poll briefly in case a cache sits in front.
  const visitor = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: accessHeaders() });
  const vp = await visitor.newPage();
  await expect(async () => {
    const res = await vp.goto(`/${TEST_SLUG}?e2e=${Date.now()}`);
    expect(res?.status()).toBe(200);
    await expect(vp.locator("h1").first()).toContainText(stamp, { timeout: 2_000 });
  }).toPass({ timeout: 90_000, intervals: [2_000, 5_000, 10_000] });
  await vp.screenshot({ path: test.info().outputPath("visitor-view.png"), fullPage: true });

  // Unlisted: the sidebar does not link to the test page.
  await expect(vp.locator(`nav a[href$="/${TEST_SLUG}"], nav a[href$="/${TEST_SLUG}/"]`)).toHaveCount(0);
  await visitor.close();
});
