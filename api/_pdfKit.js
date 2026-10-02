// Small PDF report builder on top of pdf-lib: header band, headings, text, KPI tiles and
// auto-paginating tables. Used for the PDFs that go with report emails.
//
// NOTE: this exact file also lives in the owner portal repo (api/_pdfKit.js). Keep both in sync.
//
// Standard PDF fonts only cover basic Latin and have no peso sign, so text goes through
// pdfText(): the peso sign becomes "PHP ", accents are dropped and anything else that can't
// be drawn is removed (emoji) or turned into "?".
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const pdfText = (v) =>
  String(v ?? "")
    .replace(/₱\s?/g, "PHP ")
    .replace(/[—–−]/g, "-")
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/[•·]/g, "-")
    .replace(/[\u{1F000}-\u{1FFFF}\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D]/gu, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\t/g, " ")
    .replace(/[^\x20-\x7E\n]/g, "?");

const color = (h, fallback) => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h || "").trim());
  if (!m) return fallback;
  let x = m[1];
  if (x.length === 3) x = x.split("").map((c) => c + c).join("");
  return rgb(parseInt(x.slice(0, 2), 16) / 255, parseInt(x.slice(2, 4), 16) / 255, parseInt(x.slice(4, 6), 16) / 255);
};

const NAVY = rgb(0.059, 0.09, 0.165);
const BLUE = rgb(0.145, 0.388, 0.922);
const GRAY = rgb(0.42, 0.45, 0.5);
const DARK = rgb(0.07, 0.09, 0.13);
const LINE = rgb(0.9, 0.91, 0.93);

const isPng = (b) => b && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpg = (b) => b && b[0] === 0xff && b[1] === 0xd8;

const toBase64 = (bytes) => {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export class PdfReport {
  static async create({ title, subtitle = "", logoBytes = null, landscape = false, footer = "NJ POS" } = {}) {
    const doc = await PDFDocument.create();
    doc.setTitle(pdfText(title || "NJ POS report"));
    doc.setProducer("NJ POS");
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    let logo = null;
    try {
      if (isPng(logoBytes)) logo = await doc.embedPng(logoBytes);
      else if (isJpg(logoBytes)) logo = await doc.embedJpg(logoBytes);
    } catch { logo = null; }
    const r = new PdfReport(doc, font, bold, logo, { title, subtitle, landscape, footer });
    r.newPage(true);
    return r;
  }

  constructor(doc, font, bold, logo, opts) {
    Object.assign(this, { doc, font, bold, logo, opts });
    this.W = opts.landscape ? 842 : 595;
    this.H = opts.landscape ? 595 : 842;
    this.M = 36;
    this.CW = this.W - this.M * 2;
    this.page = null;
    this.y = 0;
  }

  newPage(first = false) {
    const { W, H, M } = this;
    this.page = this.doc.addPage([W, H]);
    if (first) {
      const bandH = 64;
      this.page.drawRectangle({ x: 0, y: H - bandH, width: W, height: bandH, color: NAVY });
      if (this.logo) {
        const h = 38, w = Math.min(h * (this.logo.width / this.logo.height), 200);
        this.page.drawImage(this.logo, { x: M, y: H - bandH + (bandH - h) / 2, width: w, height: w * (this.logo.height / this.logo.width) });
      } else {
        this.page.drawText("NJ POS", { x: M, y: H - 40, size: 22, font: this.bold, color: rgb(1, 1, 1) });
      }
      const t = pdfText(this.opts.title || "Report");
      const tw = this.bold.widthOfTextAtSize(t, 13);
      this.page.drawText(t, { x: W - M - tw, y: H - 30, size: 13, font: this.bold, color: rgb(1, 1, 1) });
      const s = pdfText(this.opts.subtitle || "");
      const sw = this.font.widthOfTextAtSize(s, 9);
      this.page.drawText(s, { x: W - M - sw, y: H - 46, size: 9, font: this.font, color: rgb(0.78, 0.82, 0.9) });
      this.y = H - bandH - 22;
    } else {
      this.y = H - M;
    }
  }

  ensure(h) {
    if (this.y - h < this.M + 24) this.newPage(false);
  }

  gap(h = 8) { this.y -= h; }

  wrap(text, font, size, maxW) {
    const out = [];
    for (const para of pdfText(text).split("\n")) {
      const words = [];
      for (const w of para.split(/\s+/).filter(Boolean)) {
        // keep "PHP" attached to its amount so a number never lands on a line without its currency
        if (words.length && /^PHP$/.test(words[words.length - 1])) words[words.length - 1] += " " + w;
        else words.push(w);
      }
      if (!words.length) { out.push(""); continue; }
      let line = "";
      const push = () => { if (line) out.push(line); line = ""; };
      for (let w of words) {
        while (font.widthOfTextAtSize(w, size) > maxW) {      // hard-break very long words
          let n = w.length;
          while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > maxW) n--;
          push();
          out.push(w.slice(0, n));
          w = w.slice(n);
        }
        const trial = line ? line + " " + w : w;
        if (font.widthOfTextAtSize(trial, size) <= maxW) line = trial;
        else { push(); line = w; }
      }
      push();
    }
    return out.length ? out : [""];
  }

  heading(text, level = 2, col) {
    const size = level === 1 ? 15 : level === 2 ? 12 : 10;
    this.ensure(size + 70);          // keep a heading with the first rows under it
    this.gap(level === 1 ? 6 : 8);
    this.y -= size;
    this.page.drawText(pdfText(text), { x: this.M, y: this.y, size, font: this.bold, color: color(col, level === 1 ? NAVY : DARK) });
    this.y -= 6;
  }

  text(text, { size = 9, bold = false, col, gap = 4 } = {}) {
    const font = bold ? this.bold : this.font;
    for (const line of this.wrap(text, font, size, this.CW)) {
      this.ensure(size + 4);
      this.y -= size;
      this.page.drawText(line, { x: this.M, y: this.y, size, font, color: color(col, GRAY) });
      this.y -= 3;
    }
    this.y -= gap;
  }

  // items: [{ label, value, col, bg }] shown as tiles, `perRow` per row
  kpis(items, perRow = 3) {
    const gapX = 8, h = 46;
    for (let i = 0; i < items.length; i += perRow) {
      const row = items.slice(i, i + perRow);
      const w = (this.CW - gapX * (row.length - 1)) / row.length;
      this.ensure(h + 8);
      row.forEach((it, k) => {
        const x = this.M + k * (w + gapX);
        this.page.drawRectangle({ x, y: this.y - h, width: w, height: h, color: color(it.bg, rgb(0.96, 0.96, 0.98)) });
        const lab = pdfText(it.label), val = pdfText(it.value);
        this.page.drawText(lab, { x: x + (w - this.font.widthOfTextAtSize(lab, 8)) / 2, y: this.y - 16, size: 8, font: this.font, color: GRAY });
        const vs = this.bold.widthOfTextAtSize(val, 14) > w - 10 ? 10 : 14;
        this.page.drawText(val, { x: x + (w - this.bold.widthOfTextAtSize(val, vs)) / 2, y: this.y - 35, size: vs, font: this.bold, color: color(it.col, DARK) });
      });
      this.y -= h + 8;
    }
  }

  // columns: [{ header, w (weight), align: "left"|"right"|"center" }]
  // rows:    [[cell, ...]]  cell = string | number | { text, col, bold, bg, align, span }
  table({ columns, rows, fontSize = 8, headerBg = "#f3f4f6", total = null }) {
    const pad = 4, lh = fontSize + 2.5;
    const sum = columns.reduce((s, c) => s + (c.w || 1), 0);
    const colW = columns.map((c) => (this.CW * (c.w || 1)) / sum);
    const hasHeader = columns.some((c) => c.header);

    const layout = (cells, isHeader) => {
      let ci = 0;
      const out = [];
      for (const raw of cells) {
        const c = raw && typeof raw === "object" ? raw : { text: raw };
        const span = Math.max(1, Math.min(c.span || 1, columns.length - ci));
        const width = colW.slice(ci, ci + span).reduce((s, w) => s + w, 0);
        const font = isHeader || c.bold ? this.bold : this.font;
        const lines = this.wrap(c.text ?? "", font, fontSize, width - pad * 2);
        out.push({ c, ci, span, width, font, lines, align: c.align || columns[ci]?.align || "left" });
        ci += span;
      }
      return { cells: out, h: Math.max(...out.map((o) => o.lines.length), 1) * lh + pad * 2 - 1 };
    };

    const drawRow = (row, isHeader) => {
      let x0 = this.M;
      for (const cell of row.cells) {
        const x = this.M + colW.slice(0, cell.ci).reduce((s, w) => s + w, 0);
        const bg = isHeader ? color(headerBg, null) : color(cell.c.bg, null);
        if (bg) this.page.drawRectangle({ x, y: this.y - row.h, width: cell.width, height: row.h, color: bg });
        cell.lines.forEach((ln, i) => {
          const tw = cell.font.widthOfTextAtSize(ln, fontSize);
          const tx = cell.align === "right" ? x + cell.width - pad - tw : cell.align === "center" ? x + (cell.width - tw) / 2 : x + pad;
          this.page.drawText(ln, { x: tx, y: this.y - pad - fontSize - i * lh + 1.5, size: fontSize, font: cell.font, color: color(cell.c.col, isHeader ? GRAY : DARK) });
        });
        x0 = x;
      }
      this.y -= row.h;
      this.page.drawLine({ start: { x: this.M, y: this.y }, end: { x: this.W - this.M, y: this.y }, thickness: isHeader ? 1 : 0.4, color: LINE });
    };

    const headerRow = hasHeader ? layout(columns.map((c) => ({ text: c.header || "", align: c.align })), true) : null;
    if (headerRow) { this.ensure(headerRow.h + 30); drawRow(headerRow, true); }
    const all = total ? [...rows, total] : rows;
    all.forEach((r, i) => {
      const row = layout(r, false);
      if (this.y - row.h < this.M + 24) {
        this.newPage(false);
        if (headerRow) drawRow(headerRow, true);      // repeat the header on the next page
      }
      drawRow(row, false);
    });
    this.y -= 8;
  }

  async save() {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      p.drawLine({ start: { x: this.M, y: 40 }, end: { x: this.W - this.M, y: 40 }, thickness: 0.5, color: LINE });
      p.drawText(pdfText(this.opts.footer), { x: this.M, y: 27, size: 8, font: this.font, color: GRAY });
      const label = `Page ${i + 1} of ${pages.length}`;
      p.drawText(label, { x: this.W - this.M - this.font.widthOfTextAtSize(label, 8), y: 27, size: 8, font: this.font, color: GRAY });
    });
    return toBase64(await this.doc.save());
  }
}
