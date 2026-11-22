import "./setup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("the theme, its fonts and the agent UI are wired into the page", async () => {
  const html = await fs.readFile("index.html", "utf8");
  for (const asset of [
    "/theme.css",
    "/agents.css",
    "/agents-ui.js",
    "/agent-features.js",
  ])
    assert.ok(html.includes(asset), `${asset} is linked`);
  // theme.css must load after the legacy sheets it overrides.
  assert.ok(html.indexOf("/theme.css") > html.indexOf("/app.css"));
  assert.ok(html.indexOf("/theme.css") > html.indexOf("/agents.css"));
  const css = await fs.readFile("theme.css", "utf8");
  for (const [, file] of css.matchAll(/url\("\/fonts\/([^"]+)"\)/g))
    await fs.access(`fonts/${file}`);
  assert.match(css, /color-scheme:dark/);
});

test("the legacy palette variables cannot override the theme (they are declared !important)", async () => {
  const css = await fs.readFile("theme.css", "utf8");
  const root = css.slice(
    css.indexOf(":root{"),
    css.indexOf("color-scheme:dark"),
  );
  const declarations = root.match(/--[a-z0-9-]+:[^;]+;/g) || [];
  assert.ok(declarations.length > 20);
  for (const d of declarations)
    assert.match(d, /!important;$/, `${d} must be !important`);
});

test("package prices are shown rounded up so the card never undersells the payment", async () => {
  const js = await fs.readFile("app.js", "utf8");
  assert.match(js, /Math\.ceil\(exactPi\*100\)\/100/);
  assert.doesNotMatch(js, /Math\.floor\(exactPi\)/);
});

test("the page and manifest are English-first with a dark theme colour", async () => {
  const html = await fs.readFile("index.html", "utf8");
  assert.match(html, /<html[^>]*lang="en"/);
  const manifest = JSON.parse(await fs.readFile("manifest.json", "utf8"));
  assert.equal(manifest.lang, "en");
  assert.equal(manifest.theme_color.toLowerCase(), "#0b1a12");
});

test("balances never expire: no code path calls the legacy expiry sweeps and the UI says so", async () => {
  for (const file of [
    "server/features/account/handler.js",
    "server/features/admin/handler.js",
  ]) {
    const source = await fs.readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /rpc\(\s*["']expire_/,
      `${file} must not call expire_*`,
    );
  }
  const js = await fs.readFile("app.js", "utf8");
  assert.match(js, /Your balance never expires/);
  assert.match(js, /الرصيد لا ينتهي/);
  assert.doesNotMatch(js, /valid for 30 days|صالح لمدة 30 يومًا/);
});

test("the Mini package is in the default catalog and package cards use server names", async () => {
  const { PACKAGES } = await import("../server/domain/settings.js");
  assert.equal(PACKAGES.mini.usd, 0.5);
  assert.equal(PACKAGES.mini.tokens, 25000);
  const js = await fs.readFile("app.js", "utf8");
  assert.match(js, /p\.name_en/);
  assert.match(js, /p\.popular/);
});

test("the new logo ships as SVG and valid PNGs, and the manifest points at files that exist", async () => {
  const svg = await fs.readFile("aiway-logo.svg", "utf8");
  assert.match(svg, /#B8F13B/i);
  assert.doesNotMatch(svg, /6f2dbd/i, "no legacy purple in the logo");
  for (const [file, size] of [
    ["aiway-logo.png", 512],
    ["brand/aiway-logo-1024.png", 1024],
    ["aiway-icon-192.png", 192],
    ["aiway-icon-maskable-512.png", 512],
  ]) {
    const bytes = await fs.readFile(file);
    assert.equal(bytes.subarray(1, 4).toString(), "PNG", file);
    assert.equal(bytes.readUInt32BE(16), size, `${file} width`);
    assert.equal(bytes.readUInt32BE(20), size, `${file} height`);
  }
  const manifest = JSON.parse(await fs.readFile("manifest.json", "utf8"));
  for (const icon of manifest.icons) await fs.access(icon.src.slice(1));
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable"));
  const html = await fs.readFile("index.html", "utf8");
  assert.match(html, /rel="icon" type="image\/svg\+xml"/);
});

test("the general chat card is gone and Back navigation is wired in", async () => {
  const js = await fs.readFile("app.js", "utf8");
  assert.match(js, /id!=='all-models'&&/);
  const html = await fs.readFile("index.html", "utf8");
  assert.doesNotMatch(html, /data-landing-task="all-models"/);
  assert.ok(html.includes("/nav-history.js"));
  const nav = await fs.readFile("nav-history.js", "utf8");
  assert.match(nav, /pushState/);
  assert.match(nav, /popstate/);
  // Chrome ignores history entries pushed without a user gesture.
  assert.match(nav, /pointerdown/);
});

test("agent features UI: library, preview, templates, cap and continue are wired", async () => {
  const js = await fs.readFile("agent-features.js", "utf8");
  for (const needle of [
    "prepare-preview",
    "action:'library'",
    "aiwayRunCap",
    "data-agent-continue",
    "aiwayTemplate",
  ])
    assert.ok(js.includes(needle), needle);
  const html = await fs.readFile("index.html", "utf8");
  assert.ok(html.includes("/agent-features.js"));
  const nav = await fs.readFile("nav-history.js", "utf8");
  assert.match(nav, /libraryModal:'closeLibrary'/);
});
