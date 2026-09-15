/**
 * Text extraction for the knowledge pipeline.
 *
 * Plain text, Markdown, CSV, JSON/XML and HTML are handled natively. PDF and
 * DOCX are handled by small, dependency-free readers:
 *   - DOCX is a ZIP: read word/document.xml and strip the XML tags.
 *   - PDF text is pulled from content streams (BT/ET text objects), including
 *     Flate-compressed streams.
 *
 * These are best-effort: scanned PDFs and images need OCR, which is a vision
 * service you can attach later through the custom-API connector. Xacheus reports
 * the extraction quality instead of pretending.
 */
import { inflateRawSync, inflateSync } from 'node:zlib';

export interface ExtractionResult {
  text: string;
  method: string;
  warning?: string;
}

/** Minimal ZIP entry reader (used for DOCX/XLSX/PPTX). */
function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  // Locate the end-of-central-directory record.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66_000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return entries;

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      try {
        entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
      } catch {
        entries.set(name, Buffer.alloc(0));
      }
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXmlText(xml: string): string {
  return xml
    .replace(/<w:p[^>]*>/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalisePdfText(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractPdf(buffer: Buffer): ExtractionResult {
  let text = '';
  let compressedStreams = 0;
  let failedStreams = 0;

  const source = buffer.toString('latin1');
  const streamPattern = /stream\r?\n?([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(source)) !== null) {
    const body = Buffer.from(match[1] ?? '', 'latin1');
    let decoded: Buffer | null = null;
    try {
      decoded = inflateSync(body);
      compressedStreams += 1;
    } catch {
      // Not a flate stream — try it raw (uncompressed content streams).
      decoded = body;
      failedStreams += 1;
    }
    if (!decoded) continue;
    const content = decoded.toString('latin1');
    if (!/\b(BT|Tj|TJ)\b/.test(content)) continue;

    const chunks: string[] = [];
    const textPattern = /\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]+)>/g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = textPattern.exec(content)) !== null) {
      const literal = textMatch[0] ?? '';
      if (literal.startsWith('(')) {
        chunks.push(literal.slice(1, -1).replace(/\\([()\\])/g, '$1'));
      } else if (textMatch[1] && /^[0-9A-Fa-f\s]+$/.test(textMatch[1])) {
        const hex = textMatch[1].replace(/\s+/g, '');
        // Only decode plausible ASCII/UTF-16BE literal strings.
        if (hex.length % 2 === 0) {
          let decodedHex = '';
          for (let i = 0; i < hex.length; i += 2) {
            const code = parseInt(hex.slice(i, i + 2), 16);
            if (code >= 32 && code < 127) decodedHex += String.fromCharCode(code);
          }
          if (decodedHex.length > 2) chunks.push(decodedHex);
        }
      }
    }
    if (chunks.length) text += `${chunks.join(' ')}\n`;
  }

  const cleaned = normalisePdfText(text);
  if (!cleaned) {
    return {
      text: '',
      method: 'pdf-content-streams',
      warning:
        'No selectable text found. This PDF is most likely a scan, which needs OCR — attach a vision/OCR service through the custom-API connector to index it.',
    };
  }
  return {
    text: cleaned,
    method: 'pdf-content-streams',
    warning:
      failedStreams > 0
        ? `Extracted with limited fidelity (${compressedStreams} compressed, ${failedStreams} uncompressed streams). Complex layouts may lose structure.`
        : undefined,
  };
}

function extractDocx(buffer: Buffer): ExtractionResult {
  const entries = readZipEntries(buffer);
  if (!entries.size) return { text: '', method: 'docx-zip', warning: 'The DOCX archive could not be read.' };
  const main = entries.get('word/document.xml')?.toString('utf8');
  const notes = entries.get('word/footnotes.xml')?.toString('utf8') ?? '';
  if (!main) {
    return {
      text: '',
      method: 'docx-zip',
      warning: `No word/document.xml found. Entries: ${[...entries.keys()].slice(0, 8).join(', ')}`,
    };
  }
  return { text: `${decodeXmlText(main)}\n\n${decodeXmlText(notes)}`.trim(), method: 'docx-zip' };
}

function extractXlsx(buffer: Buffer): ExtractionResult {
  const entries = readZipEntries(buffer);
  const shared = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const strings = [...shared.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXmlText(match[1] ?? ''));
  const sheets = [...entries.entries()].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const lines: string[] = [];
  for (const [name, content] of sheets) {
    lines.push(`# ${name}`);
    const rows = content.toString('utf8').match(/<row[\s\S]*?<\/row>/g) ?? [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<c[^>]*?(?:t="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)].map((match) => {
        const value = match[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? match[2]?.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
        if (match[1] === 's') return strings[Number(value)] ?? '';
        return decodeXmlText(value);
      });
      if (cells.some((cell) => cell.trim())) lines.push(cells.join(','));
    }
  }
  return { text: lines.join('\n').trim(), method: 'xlsx-zip' };
}

function looksBinary(text: string): boolean {
  const sample = text.slice(0, 2000);
  let control = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return control / Math.max(sample.length, 1) > 0.05;
}

/**
 * Main entry point: guess the format and extract text.
 * Always returns something; `warning` explains any loss of fidelity.
 */
export function extractText(buffer: Buffer, mimeType: string, filename = ''): ExtractionResult {
  const lower = filename.toLowerCase();
  const mime = mimeType.toLowerCase();

  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-' || mime.includes('pdf') || lower.endsWith('.pdf')) {
    const result = extractPdf(buffer);
    if (result.text || result.warning) return result;
  }

  const isZip = buffer.subarray(0, 2).toString('latin1') === 'PK';
  if (isZip || mime.includes('officedocument') || lower.match(/\.(docx|xlsx|pptx)$/)) {
    if (lower.endsWith('.xlsx') || mime.includes('spreadsheet')) return extractXlsx(buffer);
    if (lower.endsWith('.pptx') || mime.includes('presentation')) {
      const entries = readZipEntries(buffer);
      const slides = [...entries.entries()]
        .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort()
        .map(([name, content]) => `# ${name}\n${decodeXmlText(content.toString('utf8'))}`);
      return { text: slides.join('\n\n'), method: 'pptx-zip' };
    }
    return extractDocx(buffer);
  }

  if (mime.includes('html') || lower.match(/\.html?$/)) {
    const html = buffer.toString('utf8');
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, method: 'html-strip' };
  }

  if (mime.includes('json') || lower.endsWith('.json')) {
    const raw = buffer.toString('utf8');
    try {
      return { text: JSON.stringify(JSON.parse(raw), null, 2), method: 'json' };
    } catch {
      return { text: raw, method: 'json-loose', warning: 'The JSON did not parse; storing the raw text instead.' };
    }
  }

  const text = buffer.toString('utf8');
  if (looksBinary(text)) {
    return {
      text: '',
      method: 'unsupported-binary',
      warning:
        'This file type cannot be converted to text locally. Supported locally: PDF, DOCX, XLSX, PPTX, HTML, CSV, MD, JSON, TXT, XML and code files. Images need an OCR/vision service.',
    };
  }
  return { text: text.replace(/\r\n/g, '\n').trim(), method: 'plain-text' };
}
