import ExcelJS from "exceljs";

const BRAND = "FF6F2DBD";

// Strings that start with "=" become real formulas so totals stay live in Excel.
const cellValue = (v) =>
  typeof v === "string" && /^=.{1,500}$/.test(v) ? { formula: v.slice(1) } : v;

export async function renderXlsx(spec) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AiWay";
  workbook.created = new Date();
  for (const sheet of spec.sheets) {
    const ws = workbook.addWorksheet(sheet.name, {
      views: [
        {
          rightToLeft: spec.rtl,
          state: sheet.headers.length ? "frozen" : "normal",
          ySplit: sheet.headers.length ? 1 : 0,
        },
      ],
    });
    if (sheet.headers.length) {
      const header = ws.addRow(sheet.headers);
      header.font = { bold: true, color: { argb: "FFFFFFFF" } };
      header.alignment = {
        vertical: "middle",
        horizontal: spec.rtl ? "right" : "left",
        wrapText: true,
      };
      header.eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: BRAND },
        };
      });
    }
    for (const row of sheet.rows) ws.addRow(row.map(cellValue));
    const columns = Math.max(
      sheet.headers.length,
      ...sheet.rows.map((r) => r.length),
      1,
    );
    for (let c = 1; c <= columns; c++) {
      const longest = Math.max(
        String(sheet.headers[c - 1] ?? "").length,
        ...sheet.rows.slice(0, 200).map((r) => String(r[c - 1] ?? "").length),
      );
      ws.getColumn(c).width =
        sheet.widths[c - 1] || Math.min(60, Math.max(10, longest + 3));
    }
    if (sheet.headers.length && sheet.rows.length)
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.headers.length },
      };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
