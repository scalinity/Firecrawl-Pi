// M5's document fixtures (FIRECRAWL_PI_SPEC.md §15, §31.1: text, complex/table, scan-only, password,
// malformed, misleading MIME, oversized), generated at start so no binary lives in the repository and every
// byte is reproducible from this file. Plain PDF 1.4 written object by object with a correct xref table.
//   text.pdf       one page of prose in Helvetica, with a sentinel sentence
//   table.pdf      two text columns and a ruled table
//   scan.pdf       one page that is only an image of text (no text layer): what a scanner produces
//   encrypted.pdf  the standard security handler, revision 2 (RC4, 40-bit), with a user password
//   malformed.pdf  a PDF header over bytes that are no PDF structure
//   pages-101.pdf  101 short pages, one past the 100-page cap
//   sample.docx    a minimal Office Open XML document with a sentinel paragraph
import { createHash } from "node:crypto";
import { deflateRawSync, crc32 } from "node:zlib";

export const SENTINELS = {
  text: "FCPI-M5-TEXT-PDF sentinel: the quick brown fox jumps over the lazy dog.",
  table: "FCPI-M5-TABLE-PDF",
  scan: "FCPI SCAN 42",
  docx: "FCPI-M5-DOCX sentinel paragraph.",
};

// ---- a minimal PDF writer ---------------------------------------------------------------------------
function pdf(objects, { trailerExtra = "" } = {}) {
  // objects: array of strings or Buffers, object i+1 in order; object 1 is the catalog.
  const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let len = parts[0].length;
  objects.forEach((o, i) => {
    offsets.push(len);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o, "latin1"), Buffer.from("\nendobj\n")]);
    parts.push(b); len += b.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${len}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
const stream = (content, dict = "") => { const b = Buffer.isBuffer(content) ? content : Buffer.from(content, "latin1"); return Buffer.concat([Buffer.from(`<< /Length ${b.length} ${dict}>>\nstream\n`), b, Buffer.from("\nendstream")]); };
const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

// Pages with text content: pages is a list of content-stream strings.
function textPdf(pages) {
  const n = pages.length;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ")}] /Count ${n} >>`, FONT];
  pages.forEach((c, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`);
    objs.push(stream(c));
  });
  return pdf(objs);
}
const lines = (x, y, size, rows) => `BT /F1 ${size} Tf ${size + 4} TL ${x} ${y} Td ${rows.map((r) => `(${esc(r)}) Tj T*`).join(" ")} ET`;

export function textPdfBytes() {
  return textPdf([lines(72, 720, 12, ["FCPI M5 text document", "", SENTINELS.text, "It has several sentences of ordinary prose, set in one column,",
    "so the native parser reads it as a text-based PDF and needs no fallback.", "Product: Fixture Widget", "Price: 42.50", "In stock: yes"])]);
}

export function tablePdfBytes() {
  const left = lines(54, 740, 10, ["Left column: the first of two columns.", "Its lines run beside the right column,", "which a naive text extraction interleaves."]);
  const right = lines(320, 740, 10, ["Right column: the second column.", "Reading order matters here.", SENTINELS.table]);
  const rows = [["Item", "Qty", "Unit price"], ["Bolt", "12", "0.25"], ["Nut", "40", "0.10"], ["Washer", "100", "0.02"]];
  let table = "0.5 w ";
  for (let r = 0; r <= rows.length; r++) table += `54 ${600 - r * 20} m 354 ${600 - r * 20} l S `;
  for (const x of [54, 154, 254, 354]) table += `${x} 600 m ${x} ${600 - rows.length * 20} l S `;
  rows.forEach((row, r) => row.forEach((cell, c) => { table += `BT /F1 10 Tf ${60 + c * 100} ${586 - r * 20} Td (${esc(cell)}) Tj ET `; }));
  return textPdf([`${left} ${right} ${table}`]);
}

// A 5x7 bitmap font for the characters the scan fixture needs.
const GLYPHS = { F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"], C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"], I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"], A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"], 4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"], " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"] };
export function scanPdfBytes() {
  const text = SENTINELS.scan, scale = 8, w = 612, h = 200;
  const px = Buffer.alloc(w * h, 255);
  [...text].forEach((ch, i) => (GLYPHS[ch] ?? GLYPHS[" "]).forEach((row, y) => [...row].forEach((bit, x) => {
    if (bit !== "1") return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) px[(40 + y * scale + dy) * w + 30 + i * 6 * scale + x * scale + dx] = 0;
  })));
  const img = deflateRawSync(px);
  // A zlib stream: FlateDecode wants the zlib header and Adler-32, so wrap the raw deflate.
  const adler = (() => { let a = 1, b = 0; for (const v of px) { a = (a + v) % 65521; b = (b + a) % 65521; } return (b << 16) | a; })();
  const z = Buffer.concat([Buffer.from([0x78, 0x9c]), img, Buffer.from([(adler >>> 24) & 255, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255])]);
  return pdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
    stream(z, `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode `),
    stream(`q ${w} 0 0 ${h} 0 560 cm /Im1 Do Q`)]);
}

// ---- the standard security handler, revision 2 (PDF 1.7 §7.6.3, algorithms 2, 3 and 4) --------------
const PAD = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
const md5 = (...b) => createHash("md5").update(Buffer.concat(b)).digest();
function rc4(key, data) {
  const s = [...Array(256).keys()];
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; out[n] = data[n] ^ s[(s[i] + s[j]) & 255]; }
  return out;
}
const pad = (pw) => Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);
export function encryptedPdfBytes(userPassword = "fcpi-user", ownerPassword = "fcpi-owner") {
  const id = md5(Buffer.from("fcpi-m5-encrypted-fixture"));
  const O = rc4(md5(pad(ownerPassword)).subarray(0, 5), pad(userPassword));
  const P = -44; // print and copy refused
  const pBytes = Buffer.alloc(4); pBytes.writeInt32LE(P);
  const key = md5(pad(userPassword), O, pBytes, id).subarray(0, 5);
  const U = rc4(key, PAD);
  const objKey = (n) => md5(key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, 10);
  const content = rc4(objKey(5), Buffer.from(lines(72, 720, 12, ["This document is encrypted.", "FCPI-M5-ENCRYPTED sentinel."]), "latin1"));
  const hex = (b) => `<${b.toString("hex")}>`;
  return pdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>", FONT,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    stream(content), `<< /Filter /Standard /V 1 /R 2 /O ${hex(O)} /U ${hex(U)} /P ${P} >>`],
    { trailerExtra: `/Encrypt 6 0 R /ID [${hex(id)} ${hex(id)}] ` });
}

export function malformedPdfBytes() {
  const junk = Buffer.alloc(4096);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 131 + 7) & 255;
  return Buffer.concat([Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 9 0 R\n", "latin1"), junk, Buffer.from("\n%%EOF\n")]);
}

export function manyPagesPdfBytes(n = 101) {
  return textPdf(Array.from({ length: n }, (_, i) => lines(72, 720, 12, [`FCPI M5 page ${i + 1} of ${n}`])));
}

// An oversized body: a PDF header followed by padding, streamed so the fixture never holds it.
export const OVERSIZED_BYTES = 26 * 1048576 + 17;

// ---- a minimal DOCX (a zip with the four parts Word needs), stored uncompressed ---------------------
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, "utf8"), nb = Buffer.from(name), crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb);
    offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
export function docxBytes() {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return zip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`],
    ["word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>FCPI M5 Office document</w:t></w:r></w:p><w:p><w:r><w:t>${SENTINELS.docx}</w:t></w:r></w:p></w:body></w:document>`],
  ]);
}

export function allDocuments() {
  return { "text.pdf": textPdfBytes(), "table.pdf": tablePdfBytes(), "scan.pdf": scanPdfBytes(), "encrypted.pdf": encryptedPdfBytes(),
    "malformed.pdf": malformedPdfBytes(), "pages-101.pdf": manyPagesPdfBytes(), "sample.docx": docxBytes() };
}
