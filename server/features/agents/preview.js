import JSZip from "jszip";
import { appError, cleanText } from "../../core/http.js";
import { db } from "../../core/runtime.js";
import {
  requireUser,
  createDownloadTicket,
  verifyDownloadTicket,
} from "../auth/service.js";
import { findArtifact, readArtifactBytes } from "./artifacts.js";
import { fileContentType } from "../chat/downloads.js";

// Live preview of a generated project. The browser loads it in a sandboxed iframe from
//   /preview/<ticket>/<path>      (rewritten to /api/chat?action=preview)
// so relative links (css/style.css, js/app.js) keep working. The ticket authorises the
// whole project for 30 minutes; every file is read from the project's own ZIP, so a
// preview can never reach anything else. The response carries its OWN Content-Security-
// Policy with `sandbox` (no allow-same-origin): the page runs as an opaque origin and
// cannot read the app's storage, cookies or API.
const PREVIEW_TTL = "30m";
const MAX_FILES = 120;
const MAX_TOTAL_BYTES = 6_000_000;
const CACHE_MS = 5 * 60_000;
const cache = new Map();

export const PREVIEW_CSP = [
  "sandbox allow-scripts allow-forms allow-modals",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https://sdk.minepi.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https:",
  "media-src 'self' data: https:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

async function ownedAssistantMessage(messageId, userId) {
  const { data, error } = await db()
    .from("messages")
    .select("id,role,token_usage")
    .eq("id", messageId)
    .eq("user_id", userId)
    .eq("role", "assistant")
    .single();
  if (error || !data) throw new Error("FILE_NOT_FOUND");
  return data;
}

export const isPreviewable = (artifact) =>
  artifact?.kind === "project" ||
  /\.zip$/i.test(artifact?.name || "") ||
  /\.html?$/i.test(artifact?.name || "");

export function safeProjectPath(value) {
  let path;
  try {
    path = decodeURIComponent(String(value || "")).replace(/\\/g, "/");
  } catch {
    throw appError("INVALID_REQUEST");
  }
  path = path.replace(/^\/+/, "").replace(/\?.*$/, "");
  if (!path || path.endsWith("/")) path += "index.html";
  if (path.length > 200 || /(^|\/)\.\.(\/|$)/.test(path) || /[\0]/.test(path))
    throw appError("INVALID_REQUEST");
  return path;
}

export async function loadProjectFiles(supabase, artifact) {
  const cached = cache.get(artifact.id);
  if (cached && cached.expires > Date.now()) return cached.files;
  const bytes = await readArtifactBytes(supabase, artifact);
  const files = new Map();
  if (/\.html?$/i.test(artifact.name)) {
    files.set("index.html", bytes);
  } else {
    const zip = await JSZip.loadAsync(bytes);
    let total = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      if (files.size >= MAX_FILES) break;
      const name = entry.name.replace(/\\/g, "/").replace(/^\/+/, "");
      if (/(^|\/)\.\.(\/|$)/.test(name)) continue;
      const data = await entry.async("nodebuffer");
      total += data.length;
      if (total > MAX_TOTAL_BYTES) throw appError("ATTACHMENT_TOO_LARGE");
      files.set(name, data);
    }
    // A single top-level folder (name/index.html) is common: serve it as the root.
    const names = [...files.keys()];
    const roots = new Set(names.map((n) => n.split("/")[0]));
    if (roots.size === 1 && names.every((n) => n.includes("/"))) {
      const prefix = `${[...roots][0]}/`;
      for (const n of names) {
        files.set(n.slice(prefix.length), files.get(n));
        files.delete(n);
      }
    }
  }
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  cache.set(artifact.id, { files, expires: Date.now() + CACHE_MS });
  return files;
}

export async function preparePreview(req, res) {
  const user = await requireUser(req);
  const messageId = cleanText(req.body?.messageId, 100);
  const artifactId = cleanText(req.body?.artifactId, 100);
  if (!messageId || !artifactId) throw appError("INVALID_REQUEST");
  const artifact = findArtifact(
    await ownedAssistantMessage(messageId, user.id),
    artifactId,
  );
  if (!isPreviewable(artifact)) throw appError("INVALID_REQUEST");
  const ticket = await createDownloadTicket(
    { sub: user.id, messageId, artifactId, kind: "preview" },
    PREVIEW_TTL,
  );
  res.status(200).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(
    JSON.stringify({
      name: artifact.name,
      url: `/preview/${encodeURIComponent(ticket)}/index.html`,
    }),
  );
}

export async function servePreview(req, res) {
  const ticket = await verifyDownloadTicket(req.query?.ticket);
  if (ticket.kind !== "preview" || !ticket.artifactId)
    throw appError("UNAUTHORIZED");
  const message = await ownedAssistantMessage(
    String(ticket.messageId),
    String(ticket.sub),
  );
  const artifact = findArtifact(message, ticket.artifactId);
  const raw = Array.isArray(req.query?.path)
    ? req.query.path.join("/")
    : req.query?.path;
  const path = safeProjectPath(raw);
  const files = await loadProjectFiles(db(), artifact);
  let body =
    files.get(path) || files.get(`${path.replace(/\/$/, "")}/index.html`);
  let served = path;
  if (!body) {
    res.status(404);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Security-Policy", PREVIEW_CSP);
    return res.end("Not found in this project");
  }
  if (!files.get(path)) served = `${path.replace(/\/$/, "")}/index.html`;
  res.status(200);
  res.setHeader("Content-Type", fileContentType(served));
  res.setHeader("Content-Length", String(body.length));
  res.setHeader("Content-Security-Policy", PREVIEW_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  return res.end(body);
}
