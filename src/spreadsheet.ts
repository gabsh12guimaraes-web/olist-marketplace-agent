import { inflateRawSync } from 'node:zlib';
// Minimal, dependency-free readers. Untrusted input: bounded sizes, no formulas evaluated, values are plain strings.
export type Row = Record<string, string>;
const MAX_ROWS = 5000, MAX_UNZIPPED = 20_000_000;

export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.slice(0, clean.indexOf('\n') === -1 ? undefined : clean.indexOf('\n'));
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
      if (rows.length > MAX_ROWS) throw new Error(`Planilha excede ${MAX_ROWS} linhas`);
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function unzip(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Arquivo XLSX inválido');
  const count = buffer.readUInt16LE(eocd + 10); let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>(); let total = 0;
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Arquivo XLSX inválido');
    const method = buffer.readUInt16LE(offset + 10), compressed = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extra + comment;
    if (!/^(xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|xl\/workbook\.xml)$/.test(name)) continue;
    total += size; if (total > MAX_UNZIPPED) throw new Error('XLSX descompactado excede o limite');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressed);
    files.set(name, method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED }) : (() => { throw new Error('Compressão XLSX não suportada'); })());
  }
  return files;
}
const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (_m, e: string) =>
  ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()] ?? String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decode(m[1]!)).join('');

export function parseXlsx(buffer: Buffer): string[][] {
  const files = unzip(buffer);
  const sheetName = [...files.keys()].filter(n => n.startsWith('xl/worksheets/')).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0];
  if (!sheetName) throw new Error('XLSX sem planilhas');
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]!));
  const rows: string[][] = [];
  for (const r of files.get(sheetName)!.toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1]!.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!, body = c[2] ?? '';
      const col = (attrs.match(/r="([A-Z]+)\d+"/)?.[1] ?? '').split('').reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const type = attrs.match(/t="(\w+)"/)?.[1];
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const value = type === 's' ? shared[Number(v)] ?? '' : type === 'inlineStr' ? texts(body) : decode(v ?? '');
      row[col >= 0 ? col : row.length] = value;
    }
    rows.push(Array.from(row, x => x ?? ''));
    if (rows.length > MAX_ROWS) throw new Error(`Planilha excede ${MAX_ROWS} linhas`);
  }
  return rows;
}

const aliases: Record<string, string> = { sku: 'sku', codigo: 'sku', idproduto: 'idProduto', id: 'idProduto', idvariacao: 'idVariacao',
  estoque: 'estoque', estoquedesejado: 'estoque', quantidade: 'estoque', alvo: 'alvo', alvoestoque: 'alvo', tipoestoque: 'alvo',
  deposito: 'idDeposito', iddeposito: 'idDeposito', preco: 'preco', precodesejado: 'preco', precopromocional: 'precoPromocional',
  marketplace: 'marketplace', canal: 'marketplace', loja: 'loja', alteracao: 'alteracao', acao: 'alteracao', produto: 'produto', variacao: 'variacao',
  novosku: 'novoSku', skunovo: 'novoSku', skunovoproposto: 'novoSku' };
export const normalizeHeader = (h: string) => h.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function toRecords(matrix: string[][]): { rows: Row[]; ignoredColumns: string[] } {
  const [header, ...body] = matrix;
  if (!header) return { rows: [], ignoredColumns: [] };
  const keys = header.map(h => aliases[normalizeHeader(h)]);
  const rows = body.filter(r => r.some(v => v.trim() !== '')).map(r => Object.fromEntries(keys.flatMap((k, i) => k ? [[k, (r[i] ?? '').trim()]] : [])));
  return { rows, ignoredColumns: header.filter((_h, i) => !keys[i]) };
}

// Accepts 65,90 / 1.234,56 / 1234.56. Returns undefined for blank, NaN for garbage.
export function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  let v = value.trim().replace(/\s|R\$/g, '');
  if (v.includes(',') && v.includes('.')) v = v.replaceAll('.', '').replace(',', '.');
  else if (v.includes(',')) v = v.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
}

export function readSpreadsheet(input: { nomeArquivo: string; conteudoBase64?: string; conteudoTexto?: string }) {
  if (/\.xlsx$/i.test(input.nomeArquivo)) {
    if (!input.conteudoBase64) throw new Error('XLSX exige conteudoBase64');
    return toRecords(parseXlsx(Buffer.from(input.conteudoBase64, 'base64')));
  }
  if (/\.(csv|txt)$/i.test(input.nomeArquivo)) {
    const text = input.conteudoTexto ?? Buffer.from(input.conteudoBase64 ?? '', 'base64').toString('utf8');
    return toRecords(parseCsv(text));
  }
  throw new Error('Formato não suportado; use .csv ou .xlsx');
}
