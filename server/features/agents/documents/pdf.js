import PDFDocument from "pdfkit";
import { readFileSync } from "node:fs";

// PDF renderer with proper Arabic support. PDFKit shapes joined Arabic letters (via
// fontkit) but lays text out left-to-right word by word, so right-to-left lines would
// come out in the wrong word order. This module does its own line layout:
//   1. split a paragraph into words and classify each word RTL (has Arabic letters) or LTR,
//   2. wrap greedily by measured width,
//   3. reorder each line visually with the Unicode "reverse runs at each level" rule,
//   4. draw word by word from the right edge (RTL) or left edge (LTR).
const font = (name) =>
  readFileSync(new URL(`../../../assets/fonts/${name}`, import.meta.url));
let fontBuffers;
const fonts = () =>
  (fontBuffers ||= {
    ar: font("noto-naskh-arabic-arabic-400-normal.woff"),
    arBold: font("noto-naskh-arabic-arabic-700-normal.woff"),
    lat: font("noto-naskh-arabic-latin-400-normal.woff"),
    latBold: font("noto-naskh-arabic-latin-700-normal.woff"),
  });

const ARABIC_LETTER = /[ء-يٮ-ۓۺ-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const ARABIC_CHAR = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const LATIN_ALNUM = /[A-Za-z0-9À-ɏ]/;

export const hasArabic = (s) => ARABIC_LETTER.test(s);
// Paragraph direction follows the first strong character (Unicode rule P2/P3).
export function firstStrongRtl(text) {
  for (const ch of String(text)) {
    if (ARABIC_LETTER.test(ch)) return true;
    if (/[A-Za-z\u00C0-\u024F]/.test(ch)) return false;
  }
  return null;
}
const brand = "#6f2dbd",
  ink = "#1f1b2e",
  muted = "#6b6580",
  line = "#d9d4e6",
  tint = "#f1ecfa";

// Words are split into runs by font: Arabic-script characters use the Arabic font,
// everything else uses the Latin font (the Arabic subset has no Latin glyphs).
function runsOf(word, bold) {
  const runs = [];
  for (const ch of word) {
    const arabic = ARABIC_CHAR.test(ch);
    const name = arabic ? (bold ? "arBold" : "ar") : bold ? "latBold" : "lat";
    if (runs.at(-1)?.font === name) runs.at(-1).text += ch;
    else runs.push({ font: name, text: ch });
  }
  return runs;
}

function wordLevel(word, baseRtl) {
  if (hasArabic(word)) return 1;
  if (LATIN_ALNUM.test(word)) return baseRtl ? 2 : 0;
  return baseRtl ? 1 : 0;
}

// Unicode L2: from the highest level down to the lowest odd level, reverse every
// contiguous run of items at that level or higher.
export function reorderVisual(items) {
  const out = [...items];
  const levels = out.map((i) => i.level);
  const max = Math.max(...levels, 0);
  const minOdd =
    levels.filter((l) => l % 2 === 1).sort((a, b) => a - b)[0] ?? Infinity;
  for (let lvl = max; lvl >= minOdd && lvl > 0; lvl--) {
    for (let i = 0; i < out.length; ) {
      if (out[i].level < lvl) {
        i++;
        continue;
      }
      let j = i;
      while (j < out.length && out[j].level >= lvl) j++;
      const slice = out.slice(i, j).reverse();
      out.splice(i, j - i, ...slice);
      i = j;
    }
  }
  return out;
}

export async function renderPdf(spec) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 54,
    bufferPages: true,
    info: {
      Title: spec.title || "Document",
      Author: spec.author || "AiWay",
      Creator: "AiWay",
    },
  });
  const f = fonts();
  for (const [key, buf] of Object.entries(f)) doc.registerFont(key, buf);
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const finished = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const docRtl = spec.rtl ?? false;
  let y = doc.page.margins.top;

  const measure = (word, size, bold) =>
    runsOf(word, bold).reduce(
      (w, r) => w + doc.font(r.font).fontSize(size).widthOfString(r.text),
      0,
    );

  // Punctuation glued to a word (", ." etc.) must follow the paragraph direction, not the
  // word's: in an RTL sentence the comma after "Pi" belongs on Pi's left. Leading and
  // trailing punctuation therefore become their own zero-gap items.
  const LEAD = /^[(\[{«"'“‘]+/;
  const TRAIL = /[.,;:!?)\]}»"'”’،؛؟…]+$/;
  const MIRROR = {
    "(": ")",
    ")": "(",
    "[": "]",
    "]": "[",
    "{": "}",
    "}": "{",
    "«": "»",
    "»": "«",
    "<": ">",
    ">": "<",
  };
  function tokens(para, rtl, size, bold) {
    const out = [];
    for (const raw of para.split(/\s+/).filter(Boolean)) {
      let core = raw,
        lead = "",
        trail = "";
      if (core.length > 1) {
        lead = (core.match(LEAD) || [""])[0];
        core = core.slice(lead.length);
        trail = (core.match(TRAIL) || [""])[0];
        core = core.slice(0, core.length - trail.length);
      }
      if (!core) {
        core = raw;
        lead = trail = "";
      }
      const parts = [];
      const push = (text, glue, neutral) => {
        if (!text) return;
        const shown =
          rtl && neutral ? [...text].map((c) => MIRROR[c] || c).join("") : text;
        parts.push({
          text: shown,
          glue,
          width: measure(shown, size, bold),
          level: neutral ? (rtl ? 1 : 0) : wordLevel(text, rtl),
        });
      };
      push(lead, false, true);
      push(core, !!lead, false);
      push(trail, true, true);
      // A mixed Latin/Arabic core keeps its own level; neutral-only words stay neutral.
      out.push(...parts);
    }
    return out;
  }

  function layoutLines(text, { size, bold, maxWidth, rtl }) {
    const lines = [];
    for (const para of String(text).split("\n")) {
      const space = measure("\u00A0", size, bold) || size * 0.25;
      let current = [],
        used = 0;
      const items = tokens(para, rtl, size, bold);
      // Items that are glued to the previous one must stay on the same line.
      const units = [];
      for (const it of items) {
        if (it.glue && units.length) units.at(-1).push(it);
        else units.push([it]);
      }
      for (const unit of units) {
        const uw = unit.reduce((n, i) => n + i.width, 0);
        const need = current.length ? space + uw : uw;
        if (current.length && used + need > maxWidth) {
          lines.push({ words: current, width: used, space });
          current = [];
          used = 0;
        }
        used += current.length ? space + uw : uw;
        const id = units.indexOf(unit);
        unit.forEach((it) => current.push({ ...it, unit: id }));
      }
      lines.push({ words: current, width: used, space });
    }
    return lines;
  }

  function drawLine(ln, { x, y: top, size, bold, color, rtl, maxWidth }) {
    // Reorder, then lay out left to right. A "gap" marks the start of a new word (glued
    // punctuation has none); after reordering a gap belongs between the two items that
    // are now adjacent, so it is carried by whichever item of the pair begins a unit.
    const visual = reorderVisual(ln.words);
    let width = 0;
    const gaps = visual.map((w, i) => {
      if (i === 0) return 0;
      // Items of one unit (a word plus its glued punctuation) touch; others get a space.
      return w.unit === visual[i - 1].unit ? 0 : ln.space;
    });
    // Recompute exact width from items so right alignment stays pixel accurate.
    width = visual.reduce((n, w, i) => n + w.width + gaps[i], 0);
    let cx = rtl ? x + maxWidth - width : x;
    doc.fillColor(color);
    visual.forEach((w, i) => {
      cx += gaps[i];
      let runs = runsOf(w.text, bold);
      // An RTL word is shaped per run, but its runs must also be ordered right to left.
      if (w.level % 2 === 1) runs = [...runs].reverse();
      for (const r of runs) {
        doc
          .font(r.font)
          .fontSize(size)
          .text(r.text, cx, top, { lineBreak: false });
        cx += doc.font(r.font).fontSize(size).widthOfString(r.text);
      }
    });
  }

  // Draws a wrapped paragraph and returns its height; breaks pages between lines.
  function paragraph(text, o) {
    const rtl = o.rtl ?? firstStrongRtl(text) ?? docRtl;
    const size = o.size ?? 11;
    const lh = size * (hasArabic(text) ? 1.75 : 1.5);
    const maxWidth = o.width ?? width;
    const x = o.x ?? left;
    const lines = layoutLines(text, { size, bold: o.bold, maxWidth, rtl });
    for (const ln of lines) {
      if (y + lh > bottom()) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      drawLine(ln, {
        x,
        y,
        size,
        bold: o.bold,
        color: o.color ?? ink,
        rtl,
        maxWidth,
      });
      y += lh;
    }
    return lines.length * lh;
  }

  const ensure = (h) => {
    if (y + h > bottom()) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  };

  function listItem(text, marker, rtl) {
    const indent = 18;
    const r = rtl ?? firstStrongRtl(text) ?? docRtl;
    ensure(24);
    const top = y;
    doc.fillColor(brand).font("lat").fontSize(11);
    const mw = doc.widthOfString(marker);
    doc.text(marker, r ? left + width - mw : left, top, { lineBreak: false });
    paragraph(text, {
      x: r ? left : left + indent,
      width: width - indent,
      rtl: r,
      size: 11,
    });
  }

  function table(t) {
    const cols = Math.max(t.headers.length, ...t.rows.map((r) => r.length), 1);
    const cw = width / cols;
    const rtl = docRtl || t.headers.some(hasArabic);
    const pad = 5;
    const cellLines = (txt, bold) =>
      layoutLines(txt, { size: 10, bold, maxWidth: cw - pad * 2, rtl });
    const drawRow = (cells, header) => {
      const prepared = Array.from({ length: cols }, (_, c) =>
        cellLines(cells[c] ?? "", header),
      );
      const h = Math.max(...prepared.map((l) => l.length), 1) * 15 + pad * 2;
      ensure(h);
      prepared.forEach((lines, c) => {
        const col = rtl ? cols - 1 - c : c;
        const cx = left + col * cw;
        if (header) doc.rect(cx, y, cw, h).fill(tint);
        doc.lineWidth(0.5).strokeColor(line).rect(cx, y, cw, h).stroke();
        lines.forEach((ln, i) =>
          drawLine(ln, {
            x: cx + pad,
            y: y + pad + i * 15,
            size: 10,
            bold: header,
            color: header ? brand : ink,
            rtl,
            maxWidth: cw - pad * 2,
          }),
        );
      });
      y += h;
    };
    if (t.headers.length) drawRow(t.headers, true);
    t.rows.forEach((r) => drawRow(r, false));
    y += 8;
  }

  if (spec.title) {
    paragraph(spec.title, {
      size: 24,
      bold: true,
      color: brand,
      rtl: undefined,
    });
    y += 4;
  }
  if (spec.subtitle) {
    paragraph(spec.subtitle, { size: 13, color: muted, rtl: undefined });
    y += 6;
  }
  if (spec.title || spec.subtitle) {
    doc
      .moveTo(left, y)
      .lineTo(left + width, y)
      .lineWidth(1)
      .strokeColor(brand)
      .stroke();
    y += 14;
  }
  for (const s of spec.sections) {
    if (s.heading) {
      ensure(40);
      y += s.level === 2 ? 4 : 10;
      paragraph(s.heading, {
        size: s.level === 2 ? 13 : 16,
        bold: true,
        color: s.level === 2 ? ink : brand,
        rtl: undefined,
      });
      y += 3;
    }
    for (const p of s.paragraphs) {
      paragraph(p, {});
      y += 6;
    }
    s.bullets.forEach((b) => listItem(b, "•"));
    s.numbered.forEach((b, i) => listItem(b, `${i + 1}.`));
    if (s.bullets.length || s.numbered.length) y += 4;
    if (s.table) table(s.table);
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font("lat").fontSize(9).fillColor(muted);
    const label = `${i + 1} / ${range.count}`;
    // Writing inside the bottom margin would make PDFKit start a new page.
    const margins = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.text(label, left, doc.page.height - 36, {
      width,
      align: "center",
      lineBreak: false,
    });
    doc.page.margins.bottom = margins;
  }
  doc.end();
  return finished;
}
