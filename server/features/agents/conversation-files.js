// Files that belong to a conversation are not kept in a separate table: uploads and
// generated artifacts are recorded in each message's token_usage JSON (attachments[] and
// artifacts[]). This module rebuilds the list so agents can reuse earlier files in later
// turns without any schema change.
const MAX_MESSAGES_SCANNED = 200;

export async function loadConversationFiles(supabase, userId, conversationId) {
  const { data, error } = await supabase
    .from("messages")
    .select("id,role,token_usage,created_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_MESSAGES_SCANNED);
  if (error || !Array.isArray(data)) return [];
  const files = [];
  for (const message of data) {
    const usage = message?.token_usage;
    if (!usage || typeof usage !== "object") continue;
    for (const a of usage.attachments || [])
      if (a?.fileId && a.path)
        files.push({
          id: a.fileId,
          name: a.name,
          mime: a.type,
          size: a.size,
          path: a.path,
          textPath: a.textPath || null,
          kind: a.kind || "upload",
          pages: a.pages || null,
          origin: "upload",
          messageId: message.id,
        });
    for (const a of usage.artifacts || [])
      if (a?.id && a.path)
        files.push({
          id: a.id,
          name: a.name,
          mime: a.mime,
          size: a.size,
          path: a.path,
          textPath: null,
          kind: a.kind || "file",
          origin: "artifact",
          messageId: message.id,
        });
  }
  return files;
}
