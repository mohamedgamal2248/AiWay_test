import vm from "node:vm";
import path from "node:path";

// Static, non-executing checks for a generated Pi web project. Nothing here runs user
// code: scripts are only compiled (syntax check) and everything else is text analysis.
const isLocalRef = (ref) =>
  ref &&
  !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|mailto:|tel:|javascript:)/i.test(ref);

function resolveRef(fromFile, ref) {
  const clean = ref.split(/[?#]/)[0];
  if (!clean) return null;
  const base = clean.startsWith("/")
    ? clean.slice(1)
    : path.posix.join(path.posix.dirname(fromFile), clean);
  return path.posix.normalize(base);
}

const looksLikeModule = (code) =>
  /^\s*(import\s.+from\s|import\s*["'{(*]|export\s)/m.test(code);

export function validateProject(files) {
  const errors = [],
    warnings = [];
  const names = new Set(files.keys());
  if (!names.size) return { errors: ["The project has no files."], warnings };
  const htmlFiles = [...names].filter((n) => /\.html?$/i.test(n));
  if (htmlFiles.length && !names.has("index.html"))
    warnings.push("There is no index.html entry page at the project root.");

  const clientScripts = new Set();
  for (const file of htmlFiles) {
    const html = files.get(file);
    for (const m of html.matchAll(
      /<(?:script|link|img|source|a)\b[^>]*?(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    )) {
      const ref = m[1];
      if (!isLocalRef(ref)) {
        if (
          /<script\b/i.test(m[0]) &&
          /^https?:\/\//i.test(ref) &&
          !/^https:\/\/sdk\.minepi\.com\//.test(ref)
        )
          warnings.push(
            `${file}: external script ${ref} (only https://sdk.minepi.com is recommended).`,
          );
        continue;
      }
      const target = resolveRef(file, ref);
      if (
        target &&
        !names.has(target) &&
        !names.has(target.replace(/\/$/, "") + "/index.html")
      )
        errors.push(`${file}: references missing file "${ref}".`);
      if (/<script\b/i.test(m[0]) && target) clientScripts.add(target);
    }
    if (!/<meta[^>]+name=["']viewport["']/i.test(html))
      warnings.push(`${file}: missing <meta name="viewport"> (mobile layout).`);
    if (!/<html[^>]*\blang=/i.test(html))
      warnings.push(`${file}: <html> has no lang attribute.`);
    if (!/<title>[^<]+<\/title>/i.test(html))
      warnings.push(`${file}: missing <title>.`);
    if (/\son[a-z]+\s*=\s*["']/i.test(html))
      warnings.push(
        `${file}: inline event handlers (onclick=...) conflict with a strict CSP; use addEventListener.`,
      );
    if (
      /\bPi\.(?:init|authenticate|createPayment)\b/.test(html) &&
      !/sdk\.minepi\.com\/pi-sdk\.js/.test(html)
    )
      errors.push(
        `${file}: uses the Pi SDK but does not load https://sdk.minepi.com/pi-sdk.js.`,
      );
  }

  for (const [file, code] of files) {
    if (/\.json$/i.test(file)) {
      try {
        JSON.parse(code);
      } catch (e) {
        errors.push(`${file}: invalid JSON (${e.message}).`);
      }
    }
    if (/\.(?:js|cjs)$/i.test(file) && !looksLikeModule(code)) {
      try {
        new vm.Script(code, { filename: file });
      } catch (e) {
        errors.push(`${file}: JavaScript syntax error (${e.message}).`);
      }
    }
    const isClient = clientScripts.has(file) || /\.html?$/i.test(file);
    if (isClient && /api\.minepi\.com\/v2\/payments/.test(code))
      errors.push(
        `${file}: calls the Pi payments server API from client code; approve/complete must run on your server.`,
      );
    if (
      /(?:Authorization["']?\s*[:=]\s*["'`]Key\s+[A-Za-z0-9]{12,})|(?:PI_API_KEY\s*[:=]\s*["'`][A-Za-z0-9]{16,})/.test(
        code,
      )
    )
      errors.push(
        `${file}: contains what looks like a hard-coded Pi API key. Use an environment variable.`,
      );
    if (
      /\bPi\.createPayment\b/.test(code) &&
      !/onReadyForServerApproval/.test(code)
    )
      warnings.push(
        `${file}: Pi.createPayment without onReadyForServerApproval callback.`,
      );
  }

  const usesPayments = [...files.values()].some((c) =>
    /Pi\.createPayment/.test(c),
  );
  if (
    usesPayments &&
    ![...names].some((n) => /approve|payment/i.test(n) && !/\.html?$/i.test(n))
  )
    warnings.push(
      "Payments are used but no server-side approve/complete handler file was found.",
    );
  if (!htmlFiles.some((n) => /privacy/i.test(n)))
    warnings.push("Add privacy-policy.html (required for Pi listing).");
  return { errors, warnings };
}
