import { db } from "../../core/runtime.js";
import { requireUser } from "../auth/service.js";
import { previewKind } from "./file-preview.js";

// "Library": every file the user's agents created, newest first, grouped by message.
// Files are recorded in token_usage.artifacts of assistant messages (see artifacts.js).
const MAX_MESSAGES = 300;
const MAX_ITEMS = 200;

export async function listLibrary(req, res) {
  const user = await requireUser(req);
  const supabase = db();
  const { data, error } = await supabase
    .from("messages")
    .select("id,conversation_id,created_at,token_usage")
    .eq("user_id", user.id)
    .eq("role", "assistant")
    .not("token_usage->>agentId", "is", null)
    .order("created_at", { ascending: false })
    .limit(MAX_MESSAGES);
  if (error) throw error;
  const items = [];
  for (const row of data || []) {
    const artifacts = Array.isArray(row.token_usage?.artifacts)
      ? row.token_usage.artifacts
      : [];
    for (const a of artifacts) {
      if (!a?.id || !a.name) continue;
      items.push({
        messageId: row.id,
        conversationId: row.conversation_id,
        createdAt: row.created_at,
        agentId: row.token_usage?.agentId || null,
        id: a.id,
        name: a.name,
        mime: a.mime,
        size: a.size,
        kind: a.kind || "file",
        previewKind: previewKind(a),
        previewable: Boolean(previewKind(a)),
      });
      if (items.length >= MAX_ITEMS) break;
    }
    if (items.length >= MAX_ITEMS) break;
  }
  // Conversation titles for the "open" action (one query, only the ids we need).
  const ids = [...new Set(items.map((i) => i.conversationId))];
  const titles = {};
  if (ids.length) {
    const { data: rows } = await supabase
      .from("conversations")
      .select("id,title")
      .eq("user_id", user.id)
      .in("id", ids);
    for (const r of rows || []) titles[r.id] = r.title;
  }
  res.status(200).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(
    JSON.stringify({
      items: items.map((i) => ({
        ...i,
        conversationTitle: titles[i.conversationId] || "",
      })),
    }),
  );
}
