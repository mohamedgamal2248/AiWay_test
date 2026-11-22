import { storeArtifact, mimeForName } from "../artifacts.js";
import {
  cleanFilename,
  normalizeDocument,
  normalizeDeck,
  normalizeWorkbook,
} from "../documents/spec.js";
import { renderPdf } from "../documents/pdf.js";
import { renderDocx } from "../documents/docx.js";
import { renderPptx } from "../documents/pptx.js";
import { renderXlsx } from "../documents/xlsx.js";

const table = {
  type: "object",
  properties: {
    headers: { type: "array", items: { type: "string" } },
    rows: {
      type: "array",
      items: { type: "array", items: { type: "string" } },
    },
  },
};
const docSchema = {
  type: "object",
  properties: {
    filename: { type: "string", description: "File name without extension." },
    title: { type: "string" },
    subtitle: { type: "string" },
    rtl: { type: "boolean", description: "true for Arabic/Hebrew documents." },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          level: { type: "integer", enum: [1, 2] },
          paragraphs: { type: "array", items: { type: "string" } },
          bullets: { type: "array", items: { type: "string" } },
          numbered: { type: "array", items: { type: "string" } },
          table,
        },
      },
    },
  },
  required: ["sections"],
};

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "html",
  "css",
  "js",
  "mjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "java",
  "c",
  "cpp",
  "go",
  "rs",
  "php",
  "rb",
  "sql",
  "yaml",
  "yml",
  "xml",
  "svg",
  "sh",
  "toml",
  "ini",
  "env",
]);

async function deliver(ctx, { name, bytes, kind = "document", summary }) {
  const artifact = await storeArtifact({
    supabase: ctx.supabase,
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    name,
    bytes,
    kind,
    existing: ctx.artifacts,
  });
  ctx.artifacts.push(artifact);
  return {
    content: `Created ${artifact.name} (${Math.round(artifact.size / 1024) || 1} KB)${summary ? `: ${summary}` : ""}. It is delivered to the user automatically.`,
    artifacts: [artifact],
  };
}

// Each tool turns a structured spec into a real file. Specs, not code: the model never
// runs code, and the server controls layout, fonts, limits and RTL handling.
export function documentTools(ctx) {
  const make = (name, ext, description, schema, build, summarize) => ({
    name,
    label: (a) =>
      `${name.replace("create_", "create ")} ${String(a?.filename || a?.title || "").slice(0, 40)}`,
    description,
    parameters: schema,
    async run(args) {
      const { bytes, count } = await build(args);
      return deliver(ctx, {
        name: cleanFilename(args.filename || args.title, ext),
        bytes,
        summary: summarize(args, count),
      });
    },
  });

  return [
    make(
      "create_pdf",
      "pdf",
      "Create a PDF report/document from structured sections (headings, paragraphs, bullets, numbered lists, tables). Arabic is fully supported: set rtl=true.",
      docSchema,
      async (a) => ({ bytes: await renderPdf(normalizeDocument(a)) }),
      (a) => `${(a.sections || []).length} section(s)`,
    ),
    make(
      "create_docx",
      "docx",
      "Create an editable Word document from structured sections (headings, paragraphs, bullets, numbered lists, tables). Set rtl=true for Arabic.",
      docSchema,
      async (a) => ({ bytes: await renderDocx(normalizeDocument(a)) }),
      (a) => `${(a.sections || []).length} section(s)`,
    ),
    make(
      "create_pptx",
      "pptx",
      "Create a PowerPoint presentation. Each slide has a title and either bullets, short text or a table, plus optional speaker notes. Keep slides concise (max ~6 bullets). Set rtl=true for Arabic.",
      {
        type: "object",
        properties: {
          filename: { type: "string" },
          title: {
            type: "string",
            description: "Deck title (adds a title slide).",
          },
          subtitle: { type: "string" },
          rtl: { type: "boolean" },
          slides: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                bullets: { type: "array", items: { type: "string" } },
                text: { type: "string" },
                table,
                notes: { type: "string" },
              },
              required: ["title"],
            },
          },
        },
        required: ["slides"],
      },
      async (a) => ({ bytes: await renderPptx(normalizeDeck(a)) }),
      (a) => `${(a.slides || []).length} slide(s)`,
    ),
    make(
      "create_xlsx",
      "xlsx",
      'Create an Excel workbook. Each sheet has headers and rows (arrays of cells). Numbers stay numeric; a string starting with "=" becomes a live formula (e.g. "=SUM(B2:B10)").',
      {
        type: "object",
        properties: {
          filename: { type: "string" },
          rtl: { type: "boolean" },
          sheets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                headers: { type: "array", items: { type: "string" } },
                rows: { type: "array", items: { type: "array", items: {} } },
                column_widths: { type: "array", items: { type: "number" } },
              },
              required: ["name", "rows"],
            },
          },
        },
        required: ["sheets"],
      },
      async (a) => ({ bytes: await renderXlsx(normalizeWorkbook(a)) }),
      (a) => `${(a.sheets || []).length} sheet(s)`,
    ),
    {
      name: "create_text_file",
      label: (a) => `create ${String(a?.filename || "").slice(0, 40)}`,
      description:
        "Create a plain text based file (txt, md, csv, json, html, css, js, py, sql, xml, yaml, ...). Provide the complete content.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Including extension, e.g. data.csv",
          },
          content: { type: "string" },
        },
        required: ["filename", "content"],
        additionalProperties: false,
      },
      async run(args) {
        const name = cleanFilename(
          String(args.filename).replace(/\.[^.]+$/, ""),
          String(args.filename).split(".").pop().toLowerCase() || "txt",
        );
        const ext = name.split(".").pop();
        if (!TEXT_EXTENSIONS.has(ext))
          throw new Error(`unsupported extension .${ext}`);
        const content = String(args.content ?? "");
        if (Buffer.byteLength(content) > 400_000)
          throw new Error("content is too large (max 400 KB)");
        // A UTF-8 BOM makes Excel open CSV files with Arabic text correctly.
        const bytes = Buffer.from((ext === "csv" ? "﻿" : "") + content, "utf8");
        return deliver(ctx, { name, bytes, kind: "file" });
      },
    },
  ];
}

export { mimeForName };
