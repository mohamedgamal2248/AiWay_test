import { appError, cleanText } from "../../core/http.js";
import { db } from "../../core/runtime.js";
import {
  requireUser,
  createDownloadTicket,
  verifyDownloadTicket,
} from "../auth/service.js";
import { findArtifact, readArtifactBytes, isImageMime } from "./artifacts.js";

// Artifact downloads use the same ticket pattern as chat file downloads so they work
// inside Pi Browser (a WebView that handles navigations to Content-Disposition
// responses better than blob: URLs): the app asks for a short-lived ticket, then
// navigates to a GET URL that streams the file with `attachment`.

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

export async function prepareArtifactDownload(req, res) {
  const user = await requireUser(req);
  const messageId = cleanText(req.body?.messageId, 100);
  const artifactId = cleanText(req.body?.artifactId, 100);
  if (!messageId || !artifactId) throw appError("INVALID_REQUEST");
  const artifact = findArtifact(
    await ownedMessage(messageId, user.id),
    artifactId,
  );
  const ticket = await createDownloadTicket(
    { sub: user.id, messageId, artifactId, kind: "artifact" },
    "2m",
  );
  res.status(200).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(
    JSON.stringify({
      name: artifact.name,
      url: `/api/chat?action=artifact-download&ticket=${encodeURIComponent(ticket)}`,
    }),
  );
}

// Long-lived tickets for inline image previews; they are only issued for images.
export async function artifactViewUrls(userId, messageId, artifacts = []) {
  const urls = {};
  for (const artifact of artifacts) {
    if (!isImageMime(artifact.mime)) continue;
    const ticket = await createDownloadTicket(
      {
        sub: userId,
        messageId,
        artifactId: artifact.id,
        kind: "artifact-view",
      },
      "6h",
    );
    urls[artifact.id] =
      `/api/chat?action=artifact-view&ticket=${encodeURIComponent(ticket)}`;
  }
  return urls;
}

async function serve(req, res, expectedKind, disposition) {
  const ticket = await verifyDownloadTicket(req.query?.ticket);
  if (ticket.kind !== expectedKind || !ticket.artifactId)
    throw appError("UNAUTHORIZED");
  const message = await ownedMessage(
    String(ticket.messageId),
    String(ticket.sub),
  );
  const artifact = findArtifact(message, ticket.artifactId);
  if (
    disposition === "inline" &&
    !isImageMime(artifact.mime) &&
    artifact.mime !== "application/pdf"
  )
    throw appError("UNAUTHORIZED");
  const body = await readArtifactBytes(db(), artifact);
  const asciiName =
    artifact.name.replace(/[^a-zA-Z0-9._-]/g, "-") || "aiway-file";
  res.status(200);
  res.setHeader("Content-Type", artifact.mime || "application/octet-stream");
  res.setHeader("Content-Length", String(body.length));
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
  );
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Generated files are data, never documents that may run script in the app origin.
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  return res.end(body);
}

export const artifactDownload = (req, res) =>
  serve(req, res, "artifact", "attachment");
export const artifactView = (req, res) =>
  serve(req, res, "artifact-view", "inline");

// Preview URLs for the images of one message (used when an older conversation is opened).
export async function prepareArtifactViews(req, res) {
  const user = await requireUser(req);
  const messageId = cleanText(req.body?.messageId, 100);
  if (!messageId) throw appError("INVALID_REQUEST");
  const message = await ownedMessage(messageId, user.id);
  const list = Array.isArray(message.token_usage?.artifacts)
    ? message.token_usage.artifacts
    : [];
  const urls = await artifactViewUrls(user.id, messageId, list);
  res.status(200).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify({ urls }));
}
