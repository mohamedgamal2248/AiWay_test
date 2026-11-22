import { randomUUID } from "node:crypto";
import { agentStorage } from "../../providers/storage.js";
import { appError } from "../../core/http.js";
import { safeDownloadFilename, fileContentType } from "../chat/downloads.js";

export const MAX_ARTIFACT_BYTES = 12 * 1024 * 1024;
const MAX_ARTIFACTS_PER_RUN = 12;

const MIME_BY_EXT = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export function mimeForName(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || fileContentType(name).split(";")[0];
}

export const isImageMime = (mime) => /^image\/(png|jpeg|webp|gif)$/.test(mime);

// Store bytes for the current run and return the metadata record that is later saved on
// the assistant message (token_usage.artifacts). `path` never reaches the browser; the
// client only receives {id,name,mime,size,kind}.
export async function storeArtifact({
  supabase,
  userId,
  conversationId,
  name,
  bytes,
  mime,
  kind = "file",
  existing = [],
}) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!data.length) throw new Error("file is empty");
  if (data.length > MAX_ARTIFACT_BYTES)
    throw new Error("file is too large (max 12 MB)");
  if (existing.length >= MAX_ARTIFACTS_PER_RUN)
    throw new Error("too many files created in one request");
  const id = randomUUID();
  const safeName = safeDownloadFilename(name);
  const path = `${userId}/${conversationId}/${id}/${safeName.replace(/[^\w.\-]+/g, "_")}`;
  const contentType = mime || mimeForName(safeName);
  const { error } = await agentStorage(supabase).upload(path, data, {
    contentType,
    cacheControl: "3600",
  });
  if (error) throw new Error("could not store the file");
  return {
    id,
    name: safeName,
    mime: contentType,
    size: data.length,
    path,
    kind,
  };
}

export const publicArtifact = ({ id, name, mime, size, kind }) => ({
  id,
  name,
  mime,
  size,
  kind,
});

export async function readArtifactBytes(supabase, artifact) {
  const { data, error } = await agentStorage(supabase).download(artifact.path);
  if (error || !data) throw new Error("FILE_NOT_FOUND");
  return Buffer.from(await data.arrayBuffer());
}

// Artifacts live on the assistant message that produced them; ownership is therefore
// checked against messages.user_id before any bytes are served.
export function findArtifact(message, artifactId) {
  const list = Array.isArray(message?.token_usage?.artifacts)
    ? message.token_usage.artifacts
    : [];
  const found = list.find((a) => a?.id === String(artifactId));
  if (!found?.path) throw new Error("FILE_NOT_FOUND");
  return found;
}

export async function removeArtifacts(supabase, artifacts = []) {
  const paths = artifacts.map((a) => a?.path).filter(Boolean);
  if (paths.length)
    await agentStorage(supabase)
      .remove(paths)
      .catch(() => {});
}

export function requireSafePath(value) {
  const path = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (
    !path ||
    path.length > 160 ||
    path.startsWith("/") ||
    /(^|\/)\.\.(\/|$)/.test(path) ||
    /[\0:*?"<>|]/.test(path) ||
    /^[a-zA-Z]:/.test(path)
  )
    throw appError("INVALID_REQUEST", { reason: "unsafe file path" });
  return path;
}

// Deletes everything an agent stored for a conversation (artifacts, uploads, text
// sidecars, workspace snapshot). Folders are walked a few levels deep; failures are
// logged but never block deleting the conversation itself.
export async function removeConversationFiles(
  supabase,
  userId,
  conversationId,
) {
  const storage = agentStorage(supabase);
  const paths = [];
  const walk = async (prefix, depth) => {
    if (depth > 4 || paths.length > 2000) return;
    const { data, error } = await storage.list(prefix, { limit: 1000 });
    if (error || !Array.isArray(data)) return;
    for (const entry of data) {
      const full = `${prefix}/${entry.name}`;
      // Folders have no id/metadata in Supabase listings.
      if (entry.id || entry.metadata) paths.push(full);
      else await walk(full, depth + 1);
    }
  };
  try {
    await walk(`${userId}/${conversationId}`, 0);
    for (let i = 0; i < paths.length; i += 100)
      await storage.remove(paths.slice(i, i + 100));
  } catch (error) {
    console.warn("[AGENT_FILES_CLEANUP_FAILED]", error?.message);
  }
  return paths.length;
}
