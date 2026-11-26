import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseCsv, parseNumber, readSpreadsheet, toRecords } from '../src/spreadsheet.ts';
import { explain } from '../src/diagnostics.ts';

// Minimal ZIP writer (stored + deflated entries) to build a real XLSX container in the test.
function zip(files: Record<string, string>, deflate: boolean) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content), data = deflate ? deflateRawSync(raw) : raw, n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(local, n, data); central.push(c, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('CSV: semicolon, quotes, CRLF, BOM, accented headers and Brazilian decimals', () => {
  const m = parseCsv('﻿SKU;Preço;Observação\r\n"A;1";"65,90";"diz ""oi"""\r\nB;1.234,56;\r\n');
  assert.deepEqual(m, [['SKU', 'Preço', 'Observação'], ['A;1', '65,90', 'diz "oi"'], ['B', '1.234,56', '']]);
  const { rows, ignoredColumns } = toRecords(m);
  assert.deepEqual(rows[0], { sku: 'A;1', preco: '65,90' }); assert.deepEqual(ignoredColumns, ['Observação']);
  assert.equal(parseNumber('65,90'), 65.9); assert.equal(parseNumber('1.234,56'), 1234.56); assert.equal(parseNumber('R$ 10'), 10);
  assert.ok(Number.isNaN(parseNumber('=CMD()'))); assert.equal(parseNumber(''), undefined);
});

test('XLSX: shared strings, inline strings, sparse cells, stored and deflated containers', () => {
  const files = {
    'xl/sharedStrings.xml': '<sst><si><t>SKU</t></si><si><t>Estoque</t></si><si><r><t>OVER</t></r><r><t>TULE1</t></r></si><si><t>A&amp;B</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>20</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>X1</t></is></c><c r="C3"><v>1.5</v></c></row>' +
      '<row r="4"><c r="A4" t="s"><v>3</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>ignorada</t></is></c></row></sheetData></worksheet>'
  };
  for (const deflate of [false, true]) {
    const { rows } = readSpreadsheet({ nomeArquivo: 'lote.XLSX', conteudoBase64: zip(files, deflate).toString('base64') });
    assert.deepEqual(rows, [{ sku: 'OVERTULE1', estoque: '20' }, { sku: 'X1', estoque: '1.5' }, { sku: 'A&B', estoque: '' }]);
  }
  assert.throws(() => readSpreadsheet({ nomeArquivo: 'x.xlsx', conteudoBase64: Buffer.from('not a zip').toString('base64') }), /XLSX inválido/);
  assert.throws(() => readSpreadsheet({ nomeArquivo: 'x.exe', conteudoTexto: 'a' }), /Formato não suportado/);
});

test('error explanations cover permission, auth, rate limit and unknown write outcomes', () => {
  assert.match(explain('Olist HTTP 403').correcao, /reautorize/i);
  assert.match(explain('HTTP_401').causaProvavel, /expirado/);
  assert.equal(explain('RATE_LIMITED').autoCorrigivel, true);
  assert.match(explain('UNKNOWN').correcao, /não reenvia/);
});
