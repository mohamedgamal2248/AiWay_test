import { agentStorage } from "../../../providers/storage.js";
import { loadConversationFiles } from "../conversation-files.js";
import { readArtifactBytes } from "../artifacts.js";
import { extractDocument } from "../files/extract.js";
import { webSearchTool } from "./web.js";
import { documentTools } from "./documents.js";

const DEFAULT_READ_CHARS = 6000;
const MAX_READ_CHARS = 9000;
const MAX_PARTS_PER_READ = 3;

const normalize = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFKD")
    // Arabic diacritics and tatweel never matter for matching.
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي");

// Files visible to the agent: uploads from this request, earlier uploads and artifacts
// created in this conversation (e.g. a PDF it generated a minute ago).
async function resolveFiles(ctx) {
  if (ctx._files) return ctx._files;
  const previous = await loadConversationFiles(
    ctx.supabase,
    ctx.userId,
    ctx.conversationId,
  );
  const current = (ctx.storedFiles || []).filter(Boolean).map((f) => ({
    ...f,
    origin: "upload",
  }));
  const byId = new Map();
  for (const f of [...current, ...previous, ...(ctx.artifacts || [])])
    if (f?.id && !byId.has(f.id)) byId.set(f.id, f);
  ctx._files = byId;
  return byId;
}

async function getPages(ctx, file) {
  ctx._pages ||= new Map();
  if (ctx._pages.has(file.id)) return ctx._pages.get(file.id);
  let pages = null;
  if (file.textPath) {
    const { data } = await agentStorage(ctx.supabase).download(file.textPath);
    if (data) {
      try {
        pages = JSON.parse(
          Buffer.from(await data.arrayBuffer()).toString("utf8"),
        ).pages;
      } catch {
        pages = null;
      }
    }
  }
  if (!pages) {
    const bytes = await readArtifactBytes(ctx.supabase, file);
    pages = (await extractDocument({ name: file.name, mime: file.mime, bytes }))
      .pages;
  }
  ctx._pages.set(file.id, pages);
  return pages;
}

async function requireFile(ctx, id) {
  const file = (await resolveFiles(ctx)).get(String(id));
  if (!file)
    throw new Error("unknown file_id; call list_files to see available files");
  return file;
}

export async function generalAgentTools(ctx) {
  const list = {
    name: "list_files",
    description:
      "List the files available in this conversation (uploads and files created earlier).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const files = [...(await resolveFiles(ctx)).values()];
      if (!files.length) return { content: "No files in this conversation." };
      return {
        content: files
          .map(
            (f) =>
              `${f.id} | ${f.name} | ${f.kind || f.mime} | ${Math.round((f.size || 0) / 1024)} KB | ${f.origin}${f.pages ? ` | ${f.pages} parts` : ""}`,
          )
          .join("\n"),
      };
    },
  };

  const read = {
    name: "read_file",
    label: (a) => `read part ${a?.part ?? 1}`,
    description: `Read a bounded slice of an attached or created file. PDF pages, PPTX slides, DOCX/text sections and XLSX row ranges are numbered parts starting at 1. Returns at most ${MAX_READ_CHARS} characters; use the next hint to continue. Prefer search_in_file to locate what you need first.`,
    parameters: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        part: { type: "integer", minimum: 1, default: 1 },
        to_part: {
          type: "integer",
          minimum: 1,
          description: `Optional end part (max ${MAX_PARTS_PER_READ} parts per call).`,
        },
        max_chars: {
          type: "integer",
          minimum: 500,
          maximum: MAX_READ_CHARS,
          default: DEFAULT_READ_CHARS,
        },
      },
      required: ["file_id"],
      additionalProperties: false,
    },
    async run(args) {
      const file = await requireFile(ctx, args.file_id);
      if (file.kind === "image")
        throw new Error("images cannot be read as text");
      const pages = await getPages(ctx, file);
      if (!pages.length) throw new Error("no readable text in this file");
      const start = Math.max(1, Math.floor(Number(args.part) || 1));
      if (start > pages.length)
        throw new Error(`file has only ${pages.length} parts`);
      const end = Math.min(
        pages.length,
        start + MAX_PARTS_PER_READ - 1,
        Math.max(start, Math.floor(Number(args.to_part) || start)),
      );
      const budget = Math.min(
        MAX_READ_CHARS,
        Math.max(500, Math.floor(Number(args.max_chars) || DEFAULT_READ_CHARS)),
      );
      let out = "",
        last = start - 1;
      for (let i = start; i <= end; i++) {
        const block = `[${file.name} — ${pages[i - 1].label} (${i}/${pages.length})]\n${pages[i - 1].text}\n\n`;
        if (out && out.length + block.length > budget) break;
        out += out ? block : block.slice(0, budget);
        last = i;
        if (out.length >= budget) break;
      }
      const cut =
        out.length >= budget && pages[last - 1].text.length + 60 > budget;
      return {
        content:
          out.trim() +
          (last < pages.length
            ? `\n…next: part=${cut ? last : last + 1} (of ${pages.length})`
            : "\n(end of file)"),
      };
    },
  };

  const search = {
    name: "search_in_file",
    label: (a) => `search: ${String(a?.query || "").slice(0, 40)}`,
    description:
      "Find the most relevant parts of a file (or of all files) for a query, with short snippets and part numbers. Use it before read_file on large documents.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        file_id: {
          type: "string",
          description: "Optional; omit to search every file.",
        },
        max_results: { type: "integer", minimum: 1, maximum: 8, default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(args) {
      const words = normalize(args.query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1);
      if (!words.length) throw new Error("query is empty");
      const files = args.file_id
        ? [await requireFile(ctx, args.file_id)]
        : [...(await resolveFiles(ctx)).values()].filter(
            (f) => f.kind !== "image",
          );
      const hits = [];
      for (const file of files) {
        let pages;
        try {
          pages = await getPages(ctx, file);
        } catch {
          continue;
        }
        pages.forEach((page, i) => {
          const text = normalize(page.text);
          let score = 0,
            first = -1;
          for (const w of words) {
            const found = text.split(w).length - 1;
            if (found) {
              score += 1 + Math.log(found);
              if (first < 0 || text.indexOf(w) < first) first = text.indexOf(w);
            }
          }
          if (score > 0)
            hits.push({
              file,
              part: i + 1,
              label: page.label,
              score,
              snippet: page.text
                .slice(Math.max(0, first - 100), first + 220)
                .replace(/\s+/g, " "),
            });
        });
      }
      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(
        0,
        Math.min(8, Math.max(1, Math.floor(Number(args.max_results) || 5))),
      );
      if (!top.length)
        return { content: "No matches. Try different keywords or synonyms." };
      return {
        content: top
          .map(
            (h) =>
              `${h.file.name} (file_id ${h.file.id}) — ${h.label} [part ${h.part}]: …${h.snippet}…`,
          )
          .join("\n"),
      };
    },
  };

  return [webSearchTool, list, search, read, ...documentTools(ctx)];
}
