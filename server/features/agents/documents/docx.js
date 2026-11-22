import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  ShadingType,
  LevelFormat,
} from "docx";
import { firstStrongRtl } from "./pdf.js";

// Word does its own bidi and Arabic shaping; the job here is to mark paragraphs and runs
// as RTL where needed so Word (and LibreOffice) lay them out correctly.
const FONT = "Arial";
const BRAND = "6F2DBD";

export async function renderDocx(spec) {
  const docRtl = spec.rtl;
  const dir = (text) => firstStrongRtl(text) ?? docRtl;
  const run = (text, extra = {}, rtl = false) =>
    new TextRun({ text, font: FONT, rightToLeft: rtl, ...extra });
  const para = (
    text,
    { rtl = dir(text), size = 22, bold, color, heading, spacing } = {},
  ) =>
    new Paragraph({
      heading,
      bidirectional: rtl,
      alignment: AlignmentType.START,
      spacing: { after: 120, line: 320, ...spacing },
      children: [run(text, { size, bold, color }, rtl)],
    });

  const children = [];
  if (spec.title)
    children.push(
      para(spec.title, {
        size: 48,
        bold: true,
        color: BRAND,
        heading: HeadingLevel.TITLE,
      }),
    );
  if (spec.subtitle)
    children.push(para(spec.subtitle, { size: 26, color: "6B6580" }));
  for (const s of spec.sections) {
    if (s.heading)
      children.push(
        para(s.heading, {
          size: s.level === 2 ? 28 : 34,
          bold: true,
          color: s.level === 2 ? "1F1B2E" : BRAND,
          heading:
            s.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 100 },
        }),
      );
    for (const p of s.paragraphs) children.push(para(p));
    for (const b of s.bullets)
      children.push(
        new Paragraph({
          numbering: { reference: "bullets", level: 0 },
          bidirectional: dir(b),
          alignment: AlignmentType.START,
          spacing: { after: 80, line: 300 },
          children: [run(b, { size: 22 }, dir(b))],
        }),
      );
    for (const b of s.numbered)
      children.push(
        new Paragraph({
          numbering: { reference: "numbers", level: 0 },
          bidirectional: dir(b),
          alignment: AlignmentType.START,
          spacing: { after: 80, line: 300 },
          children: [run(b, { size: 22 }, dir(b))],
        }),
      );
    if (s.table) {
      const cols = Math.max(
        s.table.headers.length,
        ...s.table.rows.map((r) => r.length),
        1,
      );
      const tableRtl = docRtl || s.table.headers.some((h) => firstStrongRtl(h));
      const cell = (text, header) =>
        new TableCell({
          shading: header
            ? { type: ShadingType.CLEAR, fill: "F1ECFA", color: "auto" }
            : undefined,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          children: [
            para(text ?? "", {
              rtl: tableRtl,
              size: 20,
              bold: header,
              color: header ? BRAND : undefined,
              spacing: { after: 0 },
            }),
          ],
        });
      const rows = [];
      if (s.table.headers.length)
        rows.push(
          new TableRow({
            tableHeader: true,
            children: Array.from({ length: cols }, (_, i) =>
              cell(s.table.headers[i], true),
            ),
          }),
        );
      for (const r of s.table.rows)
        rows.push(
          new TableRow({
            children: Array.from({ length: cols }, (_, i) => cell(r[i], false)),
          }),
        );
      const border = { style: BorderStyle.SINGLE, size: 4, color: "D9D4E6" };
      children.push(
        new Table({
          visuallyRightToLeft: tableRtl,
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: border,
            bottom: border,
            left: border,
            right: border,
            insideHorizontal: border,
            insideVertical: border,
          },
          rows,
        }),
        new Paragraph({ spacing: { after: 160 }, children: [] }),
      );
    }
  }
  const doc = new Document({
    creator: spec.author || "AiWay",
    title: spec.title || "Document",
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 540, hanging: 270 } } },
            },
          ],
        },
        {
          reference: "numbers",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 540, hanging: 270 } } },
            },
          ],
        },
      ],
    },
    sections: [{ properties: {}, children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
