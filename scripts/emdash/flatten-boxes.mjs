#!/usr/bin/env node
// Make existing note boxes (aside) and collapsible sections (details) editable
// (issue #15): rewrite each page's stored box as start marker + content + end
// marker (lib/flatten-core.mjs). The page renders the same; the editor can then
// change the text inside the box.
//
//   node flatten-boxes.mjs --url http://localhost:4321 --dev-bypass            # dry run: list what would change
//   node flatten-boxes.mjs --url http://localhost:4321 --dev-bypass --apply    # back up, write, publish
//   EMDASH_TOKEN=... node flatten-boxes.mjs --url https://<site> [--apply] [--production] [--header "K: V"]
//   node flatten-boxes.mjs --browser-script > out/flatten-browser.js           # same run, for an admin's browser
//
// Works on the page as it is now in the CMS (editors' changes elsewhere on the
// page are kept), not on the migration seed. Only box blocks change; every other
// block is untouched, keys included. Guards:
//   - dry run by default; --apply writes;
//   - a page that is not published, or has unpublished draft changes, is skipped;
//   - refuses if the listing has no draftRevisionId at all (session cannot see drafts);
//   - before the first write, every page's full before-JSON goes to out/flatten-backup-<ts>/;
//   - a page still untouched since the migration gets its migration_hash refreshed,
//     so apply.mjs keeps treating it as untouched (not "edited in the CMS");
//   - university.etop.tech and the production Worker are refused unless --production.
//
// Browser mode (prod through an admin's own session, no token): open
// <site>/_emdash/admin signed in, paste out/flatten-browser.js into the DevTools
// console. It runs the dry run and prints the plan. To write, run
// `await flattenBoxesRun({ apply: true })`: it first downloads the backup JSON,
// then writes and publishes. Same code as this tool (lib/flatten-core.mjs).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGED_FIELDS } from "./build-seed.mjs";
import { flattenBoxes, needsFlatten, fingerprintWith, runFlatten } from "./lib/flatten-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROD_HOSTS = /^(www\.)?university\.etop\.tech$|^university-emdash\.williampote\.workers\.dev$/;
export { needsFlatten };

const nodeSha256 = async (s) => createHash("sha256").update(s).digest("hex");

function parseArgs(argv) {
  const a = { url: "", token: process.env.EMDASH_TOKEN || "", apply: false, production: false, devBypass: false, browserScript: false, headers: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--url") a.url = argv[++i].replace(/\/$/, "");
    else if (k === "--apply") a.apply = true;
    else if (k === "--production") a.production = true;
    else if (k === "--dev-bypass") a.devBypass = true;
    else if (k === "--browser-script") a.browserScript = true;
    else if (k === "--header") {
      const [hk, ...rest] = argv[++i].split(":");
      a.headers[hk.trim()] = rest.join(":").trim();
    } else throw new Error(`unknown option ${k}`);
  }
  if (a.browserScript) return a;
  if (!a.url) throw new Error("--url is required");
  const host = new URL(a.url).hostname;
  if (PROD_HOSTS.test(host) && !a.production) throw new Error(`${host} is production: pass --production only with BJ's go-ahead`);
  if (a.devBypass && !/^(localhost|127\.0\.0\.1)$/.test(host)) throw new Error("--dev-bypass only exists under astro dev (localhost)");
  if (!a.devBypass && !a.token) throw new Error("set EMDASH_TOKEN (editor/admin API token), or use --dev-bypass on localhost");
  return a;
}

async function client(a) {
  const headers = { "content-type": "application/json", "x-emdash-request": "1", ...a.headers };
  if (a.devBypass) {
    const r = await fetch(`${a.url}/_emdash/api/setup/dev-bypass?redirect=/_emdash/api/auth/me`, { redirect: "manual" });
    const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]);
    if (!cookies.length) throw new Error(`dev-bypass gave no session cookie (HTTP ${r.status})`);
    headers.cookie = cookies.join("; ");
  } else headers.authorization = `Bearer ${a.token}`;
  return async function api(method, path, body) {
    const r = await fetch(`${a.url}/_emdash/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { success: false, error: { code: `HTTP_${r.status}`, message: text.slice(0, 200) } }; }
    if (!r.ok || json.success === false) throw new Error(`${method} ${path} -> ${r.status} ${json.error?.code || ""} ${json.error?.message || ""}`.trim());
    return json.data;
  };
}

// The browser variant: the shared core as source text + same-origin fetch + WebCrypto.
export function browserScript() {
  return `// eTop University: make note boxes editable (issue #15). Generated by
// scripts/emdash/flatten-boxes.mjs --browser-script; same code as the CLI.
// Paste into the DevTools console on <site>/_emdash/admin while signed in.
// Dry run now; write with: await flattenBoxesRun({ apply: true })
(() => {
${flattenBoxes.toString()}
${needsFlatten.toString()}
${fingerprintWith.toString()}
${runFlatten.toString()}
const managedFields = ${JSON.stringify(MANAGED_FIELDS)};
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function api(method, path, body) {
  const r = await fetch("/_emdash/api" + path, { method, credentials: "same-origin", headers: { "content-type": "application/json", "x-emdash-request": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { success: false, error: { code: "HTTP_" + r.status, message: text.slice(0, 200) } }; }
  if (!r.ok || json.success === false) throw new Error(method + " " + path + " -> " + r.status + " " + (json.error?.code || "") + " " + (json.error?.message || ""));
  return json.data;
}
async function saveBackups(pages) {
  const blob = new Blob([JSON.stringify({ site: location.origin, at: new Date().toISOString(), pages }, null, 1)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "flatten-backup-" + Date.now() + ".json" });
  document.body.append(a); a.click(); a.remove();
  window.__flattenBackup = pages;
  if (!confirm("Backup of " + pages.length + " page(s) downloaded (also in window.__flattenBackup). Write and publish now?")) throw new Error("stopped before writing");
}
window.flattenBoxesRun = async ({ apply = false } = {}) => {
  const { tally } = await runFlatten({ api, apply, managedFields, sha256hex, saveBackups });
  console.log(JSON.stringify(tally) + (apply ? "" : " (dry run: nothing written; run flattenBoxesRun({ apply: true }))"));
  return tally;
};
return window.flattenBoxesRun();
})();
`;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.browserScript) {
    process.stdout.write(browserScript());
    return;
  }
  const api = await client(a);
  const saveBackups = async (pages) => {
    const dir = join(HERE, "out", `flatten-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(dir, { recursive: true });
    for (const p of pages) writeFileSync(join(dir, `${p.slug.replace(/\//g, "__")}.json`), JSON.stringify(p.before, null, 1));
    console.log(`backup: ${pages.length} page(s) in ${dir}`);
  };
  const { tally } = await runFlatten({ api, apply: a.apply, managedFields: MANAGED_FIELDS, sha256hex: nodeSha256, saveBackups });
  console.log(`\n${JSON.stringify(tally)}${a.apply ? "" : " (dry run: nothing written; add --apply)"}`);
  process.exit(tally.failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(e.message || e); process.exit(2); });
}
