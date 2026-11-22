import { appError, cleanText } from "../../core/http.js";
import { db } from "../../core/runtime.js";
import { requireUser, createDownloadTicket } from "../auth/service.js";
import { findArtifact, readArtifactBytes, isImageMime } from "./artifacts.js";
import { detectKind, extractDocument } from "./files/extract.js";
import { isPreviewable } from "./preview.js";

// In-chat preview of any file an agent created. The browser gets one of:
//   {kind:"project"}                 -> use the live sandboxed project preview
//   {kind:"pdf"|"image", url}        -> short-lived inline URL (PDFs render with pdf.js)
//   {kind:"html", html}              -> DOCX / XLSX / PPTX converted to a tiny, sanitised
//                                       subset of HTML (no scripts, styles or attributes)
//   {kind:"text", text}              -> plain text, CSV, code, JSON...
// Nothing here executes the file, and the HTML is built from escaped text only.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 200_000;
const MAX_ROWS = 200;
const MAX_COLS = 20;
const MAX_SHEETS = 4;
const VIEW_TTL = "30m";

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function previewKind(artifact) {
  if (!artifact) return null;
  if (artifact.kind === "project" || isPreviewable(artifact)) {
    // A single .html file is shown as a live page; ZIPs are projects.
    return "project";
  }
  if (isImageMime(artifact.mime)) return "image";
  const kind = detectKind(artifact.name, artifact.mime);
  return ["pdf", "docx", "xlsx", "pptx", "text"].includes(kind) ? kind : null;
}

// Allow-list sanitiser for mammoth's HTML: only structural tags, no attributes except
// colspan/rowspan numbers, images and links removed.
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "sub",
  "sup",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "blockquote",
]);
export function sanitizeHtml(html) {
  return String(html)
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (match, name, attrs) => {
      const tag = name.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return "";
      if (match.startsWith("</")) return `</${tag}>`;
      if (tag === "td" || tag === "th") {
        const span = (n) => {
          const m = new RegExp(`${n}="(\\d{1,2})"`, "i").exec(attrs);
          return m ? ` ${n}="${m[1]}"` : "";
        };
        return `<${tag}${span("colspan")}${span("rowspan")}>`;
      }
      return tag === "br" ? "<br>" : `<${tag}>`;
    })
    .slice(0, MAX_TEXT * 2);
}

async function docxHtml(bytes) {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
  );
  return sanitizeHtml(value);
}

const cell = (v) => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v) return cell(v.result);
    if (Array.isArray(v.richText))
      return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text);
    if ("formula" in v) return `=${v.formula}`;
    return "";
  }
  return String(v);
};

async function xlsxHtml(bytes) {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const out = [];
  let sheets = 0;
  workbook.eachSheet((sheet) => {
    if (sheets++ >= MAX_SHEETS) return;
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_ROWS) return;
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.slice(0, MAX_COLS).map(cell));
    });
    const [head, ...body] = rows;
    out.push(
      `<h3>${esc(sheet.name)}</h3>` +
        (rows.length
          ? `<table><thead><tr>${head
              .map((c) => `<th>${esc(c)}</th>`)
              .join("")}</tr></thead><tbody>${body
              .map(
                (r) =>
                  `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`,
              )
              .join("")}</tbody></table>`
          : "<p>(empty sheet)</p>") +
        (sheet.rowCount > MAX_ROWS
          ? `<p>… ${sheet.rowCount - MAX_ROWS} more rows</p>`
          : ""),
    );
  });
  return out.join("");
}

async function pagesHtml(artifact, bytes, label) {
  const doc = await extractDocument({
    name: artifact.name,
    mime: artifact.mime,
    bytes,
  });
  return doc.pages
    .slice(0, 80)
    .map(
      (p, i) =>
        `<h3>${esc(label)} ${i + 1}</h3>` +
        p.text
          .split(/\n+/)
          .filter(Boolean)
          .map((line) => `<p>${esc(line)}</p>`)
          .join(""),
    )
    .join("");
}

async function ownedMessage(messageId, userId) {
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

function reply(res, body) {
  res.status(200).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify(body));
}

export async function prepareFilePreview(req, res) {
  const user = await requireUser(req);
  const messageId = cleanText(req.body?.messageId, 100);
  const artifactId = cleanText(req.body?.artifactId, 100);
  if (!messageId || !artifactId) throw appError("INVALID_REQUEST");
  const artifact = findArtifact(
    await ownedMessage(messageId, user.id),
    artifactId,
  );
  const kind = previewKind(artifact);
  const base = { name: artifact.name, size: artifact.size || 0 };
  if (!kind) return reply(res, { ...base, kind: "unsupported" });
  if (kind === "project") return reply(res, { ...base, kind });
  if (kind === "pdf" || kind === "image") {
    const ticket = await createDownloadTicket(
      { sub: user.id, messageId, artifactId, kind: "artifact-view" },
      VIEW_TTL,
    );
    return reply(res, {
      ...base,
      kind,
      url: `/api/chat?action=artifact-view&ticket=${encodeURIComponent(ticket)}`,
    });
  }
  if ((artifact.size || 0) > MAX_BYTES)
    return reply(res, { ...base, kind: "toolarge" });
  const bytes = await readArtifactBytes(db(), artifact);
  if (kind === "text")
    return reply(res, {
      ...base,
      kind: "text",
      text: Buffer.from(bytes).toString("utf8").slice(0, MAX_TEXT),
    });
  let html;
  try {
    if (kind === "docx") html = await docxHtml(bytes);
    else if (kind === "xlsx") html = await xlsxHtml(bytes);
    else html = await pagesHtml(artifact, bytes, "Slide");
  } catch {
    return reply(res, { ...base, kind: "unsupported" });
  }
  return reply(res, { ...base, kind: "html", html });
}
