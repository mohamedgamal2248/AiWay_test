import { randomUUID } from "node:crypto";
import { cleanText, localize } from "../../../core/http.js";
import { agentStorage } from "../../../providers/storage.js";
import { extractDocument, detectKind, buildManifest } from "./extract.js";
import { safeDownloadFilename } from "../../chat/downloads.js";

// General Agent attachments: bytes go to private storage, text is extracted once into a
// sidecar JSON, and the model receives only a manifest (name, size, outline, preview)
// plus a file_id for read_file/search_in_file. A 300-page PDF therefore costs a few
// hundred tokens instead of filling the context window.
function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(dataUrl));
  if (!match) return null;
  return match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf8");
}

export async function ingestAttachments({
  supabase,
  userId,
  conversationId,
  attachments,
  baseText,
  locale,
}) {
  const storage = agentStorage(supabase);
  const storedFiles = [];
  const richParts = [];
  const manifests = [];
  for (const attachment of attachments) {
    const name = safeDownloadFilename(cleanText(attachment.name, 150));
    const isText = typeof attachment.text === "string";
    const bytes = isText
      ? Buffer.from(attachment.text, "utf8")
      : decodeDataUrl(attachment.dataUrl);
    if (!bytes) {
      storedFiles.push(null);
      continue;
    }
    const mime = isText ? attachment.type || "text/plain" : attachment.type;
    const kind = isText ? "text" : detectKind(name, mime);
    const id = randomUUID();
    const base = `${userId}/${conversationId}/uploads/${id}`;
    const entry = {
      id,
      name,
      size: bytes.length,
      mime,
      kind,
      path: `${base}/${name.replace(/[^\w.\-]+/g, "_")}`,
    };

    // Images stay native (vision) for this turn and are also kept for later tools.
    if (kind === "image") {
      richParts.push({
        type: "image_url",
        image_url: { url: attachment.dataUrl },
      });
      manifests.push(buildManifest(entry, { kind, pages: [], chars: 0 }));
    } else {
      let doc = { kind, pages: [], chars: 0 };
      try {
        doc = await extractDocument({ name, mime, bytes });
      } catch (error) {
        console.warn("[AGENT_EXTRACT_FAILED]", kind, error?.message);
      }
      entry.pages = doc.pages.length;
      // Scanned PDFs have no text layer: let the model look at the file natively.
      if (
        kind === "pdf" &&
        doc.chars < 40 * Math.max(1, doc.pages.length) &&
        bytes.length <= 2_800_000
      )
        richParts.push({
          type: "file",
          file: { filename: name, file_data: attachment.dataUrl },
        });
      if (doc.pages.length) {
        const sidecar = Buffer.from(JSON.stringify({ pages: doc.pages }));
        const { error } = await storage.upload(`${base}/text.json`, sidecar, {
          contentType: "application/json",
        });
        if (!error) entry.textPath = `${base}/text.json`;
      }
      manifests.push(buildManifest(entry, doc));
    }
    const { error } = await storage.upload(entry.path, bytes, {
      contentType: mime || "application/octet-stream",
    });
    storedFiles.push(error ? null : entry);
  }
  const header = localize(
    locale,
    "الملفات المرفقة (لم تُلصق بالكامل؛ استخدم read_file وsearch_in_file لقراءة ما تحتاجه فقط):",
    "Attached files (not pasted in full; use read_file and search_in_file to read only what you need):",
  );
  return {
    text: `${baseText}\n\n${header}\n${manifests.map((m) => `---\n${m}`).join("\n")}`,
    richParts,
    storedFiles,
  };
}
