import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const root = process.cwd(),
  output = path.resolve(root, "public");
// Public output is an allowlist. Server code, tests, SQL and env files stay private.
if (output !== path.join(root, "public")) throw Error("Invalid build output");
await fs.mkdir(output, { recursive: true });
const assets = (await fs.readdir(root, { withFileTypes: true })).filter(
  (entry) =>
    entry.isFile() &&
    (/\.(html|css|png|svg|ico|webp|jpg|woff2?)$/.test(entry.name) ||
      (entry.name.endsWith(".js") && !entry.name.endsWith(".config.js")) ||
      ["manifest.json", "validation-key.txt"].includes(entry.name)),
);
const allowed = new Set(assets.map((entry) => entry.name));
for (const entry of await fs.readdir(output, { withFileTypes: true })) {
  if (allowed.has(entry.name)) continue;
  const target = path.resolve(output, entry.name);
  if (!target.startsWith(output + path.sep))
    throw Error("Invalid generated asset path");
  await fs.rm(target, { recursive: entry.isDirectory(), force: true });
}
for (const asset of assets)
  await fs.copyFile(path.join(root, asset.name), path.join(output, asset.name));
// Content hashes refresh cached scripts/styles when a release changes them.
const hashes = new Map();
for (const asset of assets.filter((asset) => /\.(js|css)$/.test(asset.name))) {
  hashes.set(
    "/" + asset.name,
    createHash("sha256")
      .update(await fs.readFile(path.join(output, asset.name)))
      .digest("hex")
      .slice(0, 12),
  );
}
for (const asset of assets.filter((asset) => asset.name.endsWith(".html"))) {
  const file = path.join(output, asset.name),
    html = await fs.readFile(file, "utf8");
  await fs.writeFile(
    file,
    html.replace(
      /((?:src|href)=["'])(\/[^"'?]+\.(?:js|css))(?:\?[^"']*)?(["'])/g,
      (match, prefix, url, quote) =>
        hashes.has(url)
          ? prefix + url + "?v=" + hashes.get(url) + quote
          : match,
    ),
  );
}
// Self-hosted fonts (CSP only allows same-origin styles): copied as an allowlist of woff2 files.
const fontsOut = path.join(output, "fonts");
await fs.rm(fontsOut, { recursive: true, force: true });
let fontCount = 0;
try {
  await fs.mkdir(fontsOut, { recursive: true });
  for (const entry of await fs.readdir(path.join(root, "fonts"))) {
    if (!/\.woff2$/.test(entry)) continue;
    await fs.copyFile(
      path.join(root, "fonts", entry),
      path.join(fontsOut, entry),
    );
    fontCount++;
  }
} catch {
  // No fonts directory: the theme falls back to system fonts.
}
// Vendored browser libraries (pdf.js for the in-chat PDF preview), copied as an allowlist.
const vendorOut = path.join(output, "vendor");
await fs.rm(vendorOut, { recursive: true, force: true });
try {
  for (const dir of await fs.readdir(path.join(root, "vendor"))) {
    await fs.mkdir(path.join(vendorOut, dir), { recursive: true });
    for (const entry of await fs.readdir(path.join(root, "vendor", dir))) {
      if (!/\.(js|txt|md)$|^LICENSE/.test(entry)) continue;
      await fs.copyFile(
        path.join(root, "vendor", dir, entry),
        path.join(vendorOut, dir, entry),
      );
    }
  }
} catch {
  // No vendor directory.
}
console.log(
  "Built " + assets.length + " public assets, " + fontCount + " fonts.",
);
