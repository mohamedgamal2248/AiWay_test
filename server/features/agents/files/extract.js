import JSZip from "jszip";

// Turns an uploaded document into "pages": an array of {label, text}. PDF pages and PPTX
// slides map 1:1; DOCX/text/CSV are split into ~3,000 character sections at paragraph
// boundaries; each XLSX sheet becomes one or more row-range sections. Everything that
// follows (manifests, read_file, search_in_file) works on this one model, so a file is
// parsed once and never has to be pasted into the model's context in full.
const SECTION_CHARS = 3000;
const MAX_PAGES = 2000;
const MAX_TEXT_CHARS = 4_000_000;

const EXT_KIND = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  csv: "text",
  tsv: "text",
  txt: "text",
  md: "text",
  json: "text",
  xml: "text",
  html: "text",
  css: "text",
  js: "text",
  ts: "text",
  py: "text",
  sql: "text",
  yaml: "text",
  yml: "text",
};

export function detectKind(name, mime = "") {
  const ext = String(name).split(".").pop().toLowerCase();
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  const type = String(mime).toLowerCase();
  if (type.includes("pdf")) return "pdf";
  if (type.includes("wordprocessingml")) return "docx";
  if (type.includes("spreadsheetml")) return "xlsx";
  if (type.includes("presentationml")) return "pptx";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/")) return "text";
  return "other";
}

export function chunkText(text, size = SECTION_CHARS) {
  const pages = [];
  let current = "";
  for (const para of String(text).split(/\n{2,}/)) {
    const piece =
      para.length > size
        ? para.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))
        : [para];
    for (const part of piece) {
      if (current && current.length + part.length + 2 > size) {
        pages.push(current);
        current = "";
      }
      current += (current ? "\n\n" : "") + part;
    }
  }
  if (current.trim()) pages.push(current);
  return pages.map((t, i) => ({ label: `section ${i + 1}`, text: t }));
}

async function extractPdf(bytes) {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [String(text)])
    .slice(0, MAX_PAGES)
    .map((t, i) => ({ label: `page ${i + 1}`, text: String(t).trim() }));
}

async function extractDocx(bytes) {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  return chunkText(value);
}

const cellText = (v) => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    // Formulas keep their expression when Excel has not cached a result yet.
    if ("formula" in v || "sharedFormula" in v)
      return v.result != null
        ? cellText(v.result)
        : `=${v.formula ?? v.sharedFormula}`;
    if ("result" in v) return cellText(v.result);
    if ("text" in v) return String(v.text);
    if (Array.isArray(v.richText))
      return v.richText.map((r) => r.text).join("");
    return JSON.stringify(v);
  }
  return String(v);
};

async function extractXlsx(bytes) {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const pages = [];
  workbook.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(`${number}: ${values.map(cellText).join(" | ")}`);
    });
    let part = [],
      size = 0,
      first = 1;
    const flush = (last) => {
      if (!part.length) return;
      pages.push({
        label: `sheet "${sheet.name}" rows ${first}-${last}`,
        text: part.join("\n"),
      });
      part = [];
      size = 0;
    };
    rows.forEach((line, i) => {
      if (!part.length) first = Number.parseInt(line, 10);
      part.push(line);
      size += line.length;
      if (size >= SECTION_CHARS) flush(Number.parseInt(line, 10));
    });
    if (part.length) flush(Number.parseInt(part.at(-1), 10));
    if (!rows.length)
      pages.push({ label: `sheet "${sheet.name}"`, text: "(empty sheet)" });
  });
  return pages.slice(0, MAX_PAGES);
}

async function extractPptx(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)));
  const textOf = (xml) =>
    [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
      .map((m) =>
        m[1]
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, "&"),
      )
      .join("\n");
  const pages = [];
  for (const name of slideNames.slice(0, MAX_PAGES)) {
    const number = Number(name.match(/\d+/));
    let text = textOf(await zip.file(name).async("string"));
    const notes = zip.file(`ppt/notesSlides/notesSlide${number}.xml`);
    if (notes)
      text += `\n[speaker notes]\n${textOf(await notes.async("string"))}`;
    pages.push({ label: `slide ${number}`, text: text.trim() });
  }
  return pages;
}

export async function extractDocument({ name, mime, bytes }) {
  const kind = detectKind(name, mime);
  let pages = [];
  if (kind === "pdf") pages = await extractPdf(bytes);
  else if (kind === "docx") pages = await extractDocx(bytes);
  else if (kind === "xlsx") pages = await extractXlsx(bytes);
  else if (kind === "pptx") pages = await extractPptx(bytes);
  else if (kind === "text")
    pages = chunkText(Buffer.from(bytes).toString("utf8"));
  let total = 0;
  pages = pages.filter((p) => (total += p.text.length) <= MAX_TEXT_CHARS);
  return {
    kind,
    pages,
    chars: pages.reduce((n, p) => n + p.text.length, 0),
  };
}

// A compact description the model sees instead of the file itself.
export function buildManifest(file, doc) {
  const lines = [
    `file_id: ${file.id}`,
    `name: ${file.name}`,
    `type: ${doc.kind} (${Math.round((file.size || 0) / 1024)} KB)`,
  ];
  if (doc.pages.length) {
    lines.push(
      `parts: ${doc.pages.length} (${doc.pages[0].label} … ${doc.pages.at(-1).label}), ${doc.chars} characters`,
    );
    const outline = doc.pages
      .slice(0, 12)
      .map(
        (p) => `  - ${p.label}: ${p.text.replace(/\s+/g, " ").slice(0, 70)}`,
      );
    lines.push("outline:", ...outline);
    if (doc.pages.length > 12)
      lines.push(`  … ${doc.pages.length - 12} more parts`);
    const preview = doc.pages[0].text.replace(/\s+/g, " ").slice(0, 600);
    if (preview) lines.push(`preview: ${preview}`);
  } else if (doc.kind === "image") {
    lines.push("note: image; it is visible to you only in this message.");
  } else {
    lines.push("note: no readable text could be extracted.");
  }
  return lines.join("\n");
}
