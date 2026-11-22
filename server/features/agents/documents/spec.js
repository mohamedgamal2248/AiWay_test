// Document specs are plain JSON produced by the model. They are validated and bounded
// here so a runaway tool call cannot create an enormous file or crash a renderer.
const LIMITS = {
  sections: 80,
  items: 60,
  textChars: 6000,
  slides: 40,
  bullets: 14,
  sheets: 8,
  rows: 3000,
  cols: 40,
  cell: 2000,
  totalChars: 300_000,
};

const str = (v, max = LIMITS.textChars) =>
  String(v ?? "")
    .replace(/\u0000/g, "")
    .slice(0, max);
const list = (v, max, item = (x) => str(x)) =>
  (Array.isArray(v) ? v : v == null ? [] : [v]).slice(0, max).map(item);

export function cleanFilename(name, ext, fallback = "document") {
  const base =
    str(name, 80)
      .replace(/\.[a-z0-9]{1,5}$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^[.\-]+|[.\-]+$/g, "") || fallback;
  return `${base}.${ext}`;
}

const normalizeTable = (t) =>
  t && Array.isArray(t.headers || t.rows)
    ? {
        headers: list(t.headers, LIMITS.cols, (x) => str(x, LIMITS.cell)),
        rows: list(t.rows, 400, (r) =>
          list(r, LIMITS.cols, (x) => str(x, LIMITS.cell)),
        ),
      }
    : null;

export function normalizeDocument(spec) {
  let total = 0;
  const count = (s) => {
    total += s.length;
    if (total > LIMITS.totalChars)
      throw new Error("document is too long; split it into several files");
    return s;
  };
  const sections = list(spec.sections, LIMITS.sections, (s) => ({
    heading: count(str(s?.heading, 200)),
    level: s?.level === 2 ? 2 : 1,
    paragraphs: list(
      s?.paragraphs ?? (s?.text ? String(s.text).split(/\n{2,}/) : []),
      LIMITS.items,
      (x) => count(str(x)),
    ),
    bullets: list(s?.bullets, LIMITS.items, (x) => count(str(x, 1500))),
    numbered: list(s?.numbered, LIMITS.items, (x) => count(str(x, 1500))),
    table: normalizeTable(s?.table),
  }));
  if (!sections.length && !spec.title)
    throw new Error("the document has no content");
  return {
    title: str(spec.title, 200),
    subtitle: str(spec.subtitle, 300),
    author: str(spec.author, 100),
    rtl: Boolean(spec.rtl),
    sections,
  };
}

export function normalizeDeck(spec) {
  let total = 0;
  const count = (s) => {
    total += s.length;
    if (total > LIMITS.totalChars) throw new Error("presentation is too long");
    return s;
  };
  const slides = list(spec.slides, LIMITS.slides, (s) => ({
    title: count(str(s?.title, 200)),
    bullets: list(s?.bullets, LIMITS.bullets, (x) => count(str(x, 400))),
    text: count(str(s?.text, 1200)),
    table: normalizeTable(s?.table),
    notes: count(str(s?.notes, 2000)),
  }));
  if (!slides.length) throw new Error("the presentation has no slides");
  return {
    title: str(spec.title, 200),
    subtitle: str(spec.subtitle, 300),
    rtl: Boolean(spec.rtl),
    slides,
  };
}

export function normalizeWorkbook(spec) {
  const sheets = list(spec.sheets, LIMITS.sheets, (s, i) => ({
    name:
      str(s?.name || `Sheet${i + 1}`, 31)
        .replace(/[\\/?*[\]:]/g, " ")
        .trim() || `Sheet${i + 1}`,
    headers: list(s?.headers, LIMITS.cols, (x) => str(x, 200)),
    rows: list(s?.rows, LIMITS.rows, (r) =>
      list(r, LIMITS.cols, (x) =>
        typeof x === "number" || typeof x === "boolean"
          ? x
          : str(x, LIMITS.cell),
      ),
    ),
    widths: list(s?.column_widths, LIMITS.cols, (x) =>
      Math.min(80, Math.max(6, Number(x) || 14)),
    ),
  }));
  if (!sheets.length) throw new Error("the workbook has no sheets");
  return { rtl: Boolean(spec.rtl), sheets };
}
