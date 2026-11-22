import PptxGenJS from "pptxgenjs";
import { firstStrongRtl } from "./pdf.js";

const BRAND = "6F2DBD";
const INK = "1F1B2E";
const FONT = "Arial";
const W = 13.333;

export async function renderPptx(spec) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = spec.title || "Presentation";
  pptx.author = "AiWay";
  const rtlOf = (text) => firstStrongRtl(text) ?? spec.rtl;
  const textOpts = (text, extra = {}) => {
    const rtl = rtlOf(text);
    return {
      fontFace: FONT,
      rtlMode: rtl,
      align: rtl ? "right" : "left",
      lang: rtl ? "ar-SA" : "en-US",
      ...extra,
    };
  };

  if (spec.title) {
    const s = pptx.addSlide();
    s.background = { color: BRAND };
    s.addText(spec.title, {
      ...textOpts(spec.title, {
        color: "FFFFFF",
        fontSize: 40,
        bold: true,
        x: 0.8,
        y: 2.3,
        w: W - 1.6,
        h: 1.6,
        valign: "middle",
      }),
    });
    if (spec.subtitle)
      s.addText(spec.subtitle, {
        ...textOpts(spec.subtitle, {
          color: "E9DEFA",
          fontSize: 20,
          x: 0.8,
          y: 4.0,
          w: W - 1.6,
          h: 1,
        }),
      });
  }
  spec.slides.forEach((slide, index) => {
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    s.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: W,
      h: 0.18,
      fill: { color: BRAND },
      line: { color: BRAND },
    });
    if (slide.title)
      s.addText(slide.title, {
        ...textOpts(slide.title, {
          color: BRAND,
          fontSize: 30,
          bold: true,
          x: 0.6,
          y: 0.4,
          w: W - 1.2,
          h: 0.9,
          valign: "middle",
        }),
      });
    let top = 1.5;
    if (slide.text) {
      s.addText(slide.text, {
        ...textOpts(slide.text, {
          color: INK,
          fontSize: 18,
          x: 0.7,
          y: top,
          w: W - 1.4,
          h: 1.2,
          valign: "top",
        }),
      });
      top += 1.3;
    }
    if (slide.bullets.length) {
      const rtl = rtlOf(slide.bullets[0]);
      s.addText(
        slide.bullets.map((b) => ({
          text: b,
          options: {
            bullet: true,
            breakLine: true,
            rtlMode: rtlOf(b),
            align: rtlOf(b) ? "right" : "left",
          },
        })),
        {
          fontFace: FONT,
          color: INK,
          fontSize: slide.bullets.length > 8 ? 16 : 20,
          x: 0.7,
          y: top,
          w: W - 1.4,
          h: 7.5 - top - 0.7,
          valign: "top",
          paraSpaceAfter: 8,
          rtlMode: rtl,
          lang: rtl ? "ar-SA" : "en-US",
        },
      );
    }
    if (slide.table) {
      const rows = [];
      const cellOpts = (t, header) => ({
        fontFace: FONT,
        fontSize: 14,
        bold: header,
        color: header ? "FFFFFF" : INK,
        fill: { color: header ? BRAND : "FFFFFF" },
        rtlMode: rtlOf(t),
        align: rtlOf(t) ? "right" : "left",
        border: { type: "solid", color: "D9D4E6", pt: 0.75 },
      });
      if (slide.table.headers.length)
        rows.push(
          slide.table.headers.map((h) => ({
            text: h,
            options: cellOpts(h, true),
          })),
        );
      for (const r of slide.table.rows.slice(0, 14))
        rows.push(r.map((c) => ({ text: c, options: cellOpts(c, false) })));
      s.addTable(rows, { x: 0.7, y: top, w: W - 1.4, colW: undefined });
    }
    s.addText(String(index + 1), {
      fontFace: FONT,
      fontSize: 11,
      color: "9A93B0",
      x: W - 1.2,
      y: 7.0,
      w: 0.8,
      h: 0.3,
      align: "right",
    });
    if (slide.notes) s.addNotes(slide.notes);
  });
  return Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
}
