import { Buffer } from 'node:buffer';
import { isWellFormedEtfPcfDateKey } from './etfPcfLimit.js';
import { TARGET_CODES } from '../../../shared/etfPcfSharesSchema.js';
export { TARGET_CODES };
const MAX = 1048576;
const fail = (reason) => {
  throw Error(reason);
};
export const supportsRawDeflate = () => typeof globalThis.DecompressionStream !== 'undefined';
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Restricted XML tree: no DTD, processing beyond declarations, or undeclared entities.
function xml(text) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) fail('xml_malformed');
  if (/<!/i.test(text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ''))) fail('xml_unsafe');
  const decode = (s) =>
    s.replace(/&([^;]+);/g, (_, e) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (Object.hasOwn(named, e)) return named[e];
      if (/^#(?:\d+|x[\da-f]+)$/i.test(e)) {
        const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        if ((n === 9 || n === 10 || n === 13 || n >= 32) && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff))
          return String.fromCodePoint(n);
      }
      return fail('xml_entity');
    });
  const root = { name: '', children: [], text: '' },
    stack = [root];
  let pos = 0,
    nodes = 0;
  const re = /<\?xml\s[^?]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g;
  for (const m of text.matchAll(re)) {
    if (m.index !== pos) fail('xml_malformed');
    pos = m.index + m[0].length;
    const t = m[0];
    if (t.startsWith('<?xml')) continue;
    if (t.startsWith('<![CDATA[')) {
      stack.at(-1).text += t.slice(9, -3);
      continue;
    }
    if (t.startsWith('</')) {
      if (stack.length === 1 || t !== `</${stack.at(-1).full}>`) fail('xml_malformed');
      stack.pop();
    } else if (t.startsWith('<')) {
      const tag = /^<([a-z_:][\w:.-]*)((?:\s+[a-z_:][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>$/i.exec(
        t
      );
      if (!tag) fail('xml_malformed');
      if (++nodes > 300000 || stack.length > 64) fail('xml_limit');
      const attrs = {};
      for (const a of tag[2].matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) {
        if (Object.hasOwn(attrs, a[1])) fail('xml_malformed');
        attrs[a[1]] = decode(a[3]);
      }
      const node = { name: tag[1].split(':').at(-1), full: tag[1], attrs, children: [], text: '' };
      stack.at(-1).children.push(node);
      if (!tag[3]) stack.push(node);
    } else {
      if (/&(?![^&;\s]+;)/.test(t)) fail('xml_entity');
      stack.at(-1).text += decode(t);
    }
  }
  if (pos !== text.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim())
    fail('xml_malformed');
  return root.children[0];
}
const children = (n, name) => n.children.filter((c) => c.name === name);
const descendants = (n, name) =>
  n.children.flatMap((c) => [...(c.name === name ? [c] : []), ...descendants(c, name)]);
const content = (n) => n.text + n.children.map(content).join('');
export async function unzipXlsx(input) {
  const b = Buffer.from(input);
  if (b.length > MAX) fail('download_limit');
  if (b.length < 22) fail('zip_bounds');
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0 || end + 22 + b.readUInt16LE(end + 20) !== b.length) fail('zip_bounds');
  const count = b.readUInt16LE(end + 10),
    size = b.readUInt32LE(end + 12),
    start = b.readUInt32LE(end + 16);
  if (
    b.readUInt16LE(end + 4) ||
    b.readUInt16LE(end + 6) ||
    b.readUInt16LE(end + 8) !== count ||
    count > 32 ||
    count === 65535 ||
    start === 0xffffffff ||
    size === 0xffffffff ||
    start + size !== end
  )
    fail('zip_directory');
  const result = new Map(),
    ranges = [];
  let p = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || b.readUInt32LE(p) !== 0x02014b50) fail('zip_bounds');
    const flags = b.readUInt16LE(p + 8),
      method = b.readUInt16LE(p + 10),
      crc = b.readUInt32LE(p + 16),
      compressed = b.readUInt32LE(p + 20),
      length = b.readUInt32LE(p + 24),
      nl = b.readUInt16LE(p + 28),
      extra = b.readUInt16LE(p + 30),
      comment = b.readUInt16LE(p + 32),
      off = b.readUInt32LE(p + 42),
      disk = b.readUInt16LE(p + 34);
    if (p + 46 + nl + extra + comment > end) fail('zip_bounds');
    const name = b.subarray(p + 46, p + 46 + nl).toString('utf8');
    p += 46 + nl + extra + comment;
    if (
      flags & 0x41 ||
      ![0, 8].includes(method) ||
      [compressed, length, off].includes(0xffffffff) ||
      disk !== 0
    )
      fail('zip_unsupported');
    if (
      !name ||
      name.includes('\0') ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').includes('..') ||
      /^[a-z]:/i.test(name) ||
      /\.xlsx$/i.test(name) ||
      result.has(name)
    )
      fail('zip_path');
    total += length;
    if (length > 4 * MAX || total > 8 * MAX || length > Math.max(1, compressed) * 100) fail('zip_bomb');
    if (off + 30 > start || b.readUInt32LE(off) !== 0x04034b50) fail('zip_bounds');
    const ln = b.readUInt16LE(off + 26),
      le = b.readUInt16LE(off + 28),
      dataStart = off + 30 + ln + le,
      dataEnd = dataStart + compressed;
    if (dataEnd > start || ranges.some(([a, z]) => off < z && dataEnd > a)) fail('zip_bounds');
    ranges.push([off, dataEnd]);
    if (
      b.readUInt16LE(off + 6) !== flags ||
      b.readUInt16LE(off + 8) !== method ||
      b.subarray(off + 30, off + 30 + ln).toString() !== name ||
      [18, 22].some((n) => b.readUInt32LE(off + n) === 0xffffffff)
    )
      fail('zip_header');
    if (
      !(flags & 8) &&
      (b.readUInt32LE(off + 14) !== crc ||
        b.readUInt32LE(off + 18) !== compressed ||
        b.readUInt32LE(off + 22) !== length)
    )
      fail('crc_or_length');
    let data = b.subarray(dataStart, dataEnd);
    if (method === 8) {
      if (!supportsRawDeflate()) fail('deflate_raw_unavailable');
      const reader = new Blob([data])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'))
        .getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          bytes += r.value.length;
          if (bytes > length || bytes > 4 * MAX) {
            await reader.cancel();
            fail(bytes > 4 * MAX ? 'zip_bomb' : 'crc_or_length');
          }
          chunks.push(Buffer.from(r.value));
        }
      } catch (e) {
        if (e.message === 'zip_bomb' || e.message === 'crc_or_length') throw e;
        fail('crc_or_length');
      } finally {
        reader.releaseLock();
      }
      data = Buffer.concat(chunks);
    }
    if (data.length !== length || crc32(data) !== crc) fail('crc_or_length');
    if (/\.xml$|\.rels$/i.test(name)) xml(data.toString('utf8'));
    result.set(name, Buffer.from(data));
  }
  if (p !== end) fail('zip_bounds');
  return result;
}
export function decimalShares(value, unit) {
  if (!['份', '万份'].includes(unit)) fail('unknown_unit');
  const raw = String(value);
  if (raw.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) fail('shares_decimal');
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.replaceAll(',', ''));
  if (!m) fail('shares_decimal');
  const fraction = m[2] || '',
    scale = 10n ** BigInt(fraction.length),
    n = BigInt(m[1] + fraction) * (unit === '万份' ? 10000n : 1n);
  if (n % scale || n / scale > BigInt(Number.MAX_SAFE_INTEGER)) fail('shares_integer');
  return Number(n / scale);
}
export async function parseEtfPcfSharesXlsx(buffer, { codes = TARGET_CODES, includeEvidence = false } = {}) {
  const files = await unzipXlsx(buffer),
    read = (name) => {
      const b = files.get(name);
      if (!b) fail('report_shape');
      return xml(b.toString());
    };
  const book = read('xl/workbook.xml'),
    sheets = descendants(book, 'sheet');
  if (sheets.length !== 1) fail('report_shape');
  const rel = descendants(read('xl/_rels/workbook.xml.rels'), 'Relationship').find(
    (r) => r.attrs.Id === sheets[0].attrs['r:id']
  );
  if (!rel || !rel.attrs.Type.endsWith('/worksheet')) fail('report_shape');
  const target = rel.attrs.Target;
  if (target.includes('..') || target.includes('\\') || rel.attrs.TargetMode === 'External')
    fail('report_shape');
  const sheet = read(target.startsWith('/xl/') ? target.slice(1) : 'xl/' + target);
  const rows = descendants(sheet, 'row');
  if (rows.length > 20000) fail('row_limit');
  if (descendants(sheet, 'c').length > 200000) fail('cell_limit');
  const strings = files.has('xl/sharedStrings.xml')
    ? descendants(read('xl/sharedStrings.xml'), 'si').map(content)
    : [];
  if (strings.length > 50000 || strings.some((s) => s.length > 4096)) fail('shared_string_limit');
  const styles = files.has('xl/styles.xml') ? read('xl/styles.xml') : null,
    formats = styles ? descendants(styles, 'numFmt') : [];
  const xfs = styles ? descendants(styles, 'cellXfs').flatMap((n) => children(n, 'xf')) : [];
  const value = (c) => {
    if (c.attrs.t === 'inlineStr') return content(c);
    const v = children(c, 'v')[0];
    const s = v ? content(v) : '';
    if (c.attrs.t === 's') {
      if (!/^\d+$/.test(s) || !Object.hasOwn(strings, s)) fail('shared_string_index');
      return strings[Number(s)];
    }
    return s;
  };
  const table = rows.map((r) =>
    children(r, 'c').map((c) => ({ cell: c, col: (c.attrs.r || '').replace(/\d+$/, ''), value: value(c) }))
  );
  let header, codeCol, sharesCol, dateCol, nameCol, unit;
  for (const row of table) {
    const a = row.find((c) => /基金代码|证券代码/.test(c.value)),
      b = row.find((c) => /份额|规模/.test(c.value)),
      d = row.find((c) => /^(日期|报表日期|截止日期|报告日期|统计日期|数据日期)$/.test(c.value));
    if (a && b) {
      if (!d) continue;
      header = row;
      codeCol = a.col;
      sharesCol = b.col;
      dateCol = d.col;
      nameCol = row.find((c) => /^(基金简称|证券简称)$/.test(c.value))?.col;
      unit = /[（(]\s*(万份|份)\s*[）)]/.exec(b.value)?.[1] || null;
      break;
    }
  }
  if (!header) {
    if (table.some((r) => r.some((c) => /基金代码/.test(c.value)))) fail('missing_report_date');
    fail('report_shape');
  }
  if (!unit) fail('unknown_unit');
  const system1904 = ['true', '1'].includes(descendants(book, 'workbookPr')[0]?.attrs.date1904),
    records = [];
  for (const row of table.slice(table.indexOf(header) + 1)) {
    const a = row.find((c) => c.col === codeCol),
      b = row.find((c) => c.col === sharesCol),
      d = row.find((c) => c.col === dateCol);
    if (!a) continue;
    let code = a.value;
    if (/^\d{1,6}$/.test(code)) code = code.padStart(6, '0');
    if (!codes.includes(code)) continue;
    if (!b || !d) fail('report_shape');
    let date = d.value;
    if (!isWellFormedEtfPcfDateKey(date)) {
      if (!/^\d+(?:\.0+)?$/.test(date)) fail('excel_date');
      const id = Number(xfs[Number(d.cell.attrs.s)]?.attrs.numFmtId),
        custom = formats.find((f) => Number(f.attrs.numFmtId) === id)?.attrs.formatCode;
      if (!((id >= 14 && id <= 17) || id === 22 || (custom && /[dy]/i.test(custom.replace(/"[^"]*"/g, '')))))
        fail('untyped_date');
      const serial = Number(date);
      if (!system1904 && serial === 60) fail('excel_date');
      const ms =
        (system1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31)) +
        (serial - (!system1904 && serial > 60 ? 1 : 0)) * 86400000;
      date = new Date(ms).toISOString().slice(0, 10);
      if (!isWellFormedEtfPcfDateKey(date)) fail('excel_date');
    }
    if (records.some((r) => r.code === code && r.date === date)) fail('report_shape');
    records.push({
      code,
      date,
      shares: decimalShares(b.value, unit),
      unit,
      ...(includeEvidence
        ? {
            ...(nameCol ? { name: row.find((c) => c.col === nameCol)?.value || code } : {}),
            dateEvidence: {
              source: 'szse_fund_report',
              column: header.find((c) => c.col === dateCol).value,
              type: isWellFormedEtfPcfDateKey(d.value) ? 'iso_date' : 'excel_date'
            }
          }
        : {})
    });
  }
  if (!records.length) fail('report_shape');
  return records;
}
export const CURRENT_SHARES_URL =
  'https://fund.szse.cn/api/report/ShowReport?SHOWTYPE=xlsx&CATALOGID=1000_lf&TABKEY=tab1';
export function historicalSharesUrl(startDate, endDate) {
  if (!isWellFormedEtfPcfDateKey(startDate) || !isWellFormedEtfPcfDateKey(endDate) || startDate > endDate)
    fail('date_range');
  const end = new Date(startDate);
  const originalDay = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 6);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(originalDay, lastDay));
  if (Date.parse(endDate) > end.getTime()) fail('date_range');
  return `https://www.szse.cn/api/report/ShowReport?SHOWTYPE=xlsx&CATALOGID=scsj_fund_jjgm&TABKEY=tab1&txtStart=${startDate}&txtEnd=${endDate}&jjlb=ETF`;
}
export async function fetchEtfPcfShares({
  url = CURRENT_SHARES_URL,
  fetchImpl = fetch,
  timeoutMs = 8000,
  signal
} = {}) {
  if (signal?.aborted) return { ok: false, reason: 'timeout' };
  let reader;
  const controller = new AbortController(),
    abort = () => {
      controller.abort();
      reader?.cancel().catch(() => {});
    };
  const timedOut = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(Error('timeout')), { once: true });
  });
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await Promise.race([
      fetchImpl(url, { redirect: 'manual', signal: controller.signal }),
      timedOut
    ]);
    if (response.status >= 300 && response.status <= 399) {
      await response.body?.cancel();
      return { ok: false, reason: 'redirect_rejected' };
    }
    if (
      response.status !== 200 ||
      /html/i.test(response.headers?.get('content-type') || '') ||
      Number(response.headers?.get('content-length')) > MAX
    ) {
      await response.body?.cancel();
      return { ok: false, reason: 'download_rejected' };
    }
    reader = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      for (;;) {
        const r = await Promise.race([reader.read(), timedOut]);
        if (controller.signal.aborted) throw Error('timeout');
        if (r.done) break;
        size += r.value.length;
        if (size > MAX) {
          await reader.cancel();
          return { ok: false, reason: 'download_limit' };
        }
        parts.push(Buffer.from(r.value));
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(parts);
    if (
      /^\s*(?:<!doctype\s+html|<(?:html|head|body|title|script|meta)\b)/i.test(
        bytes.subarray(0, 512).toString()
      )
    )
      return { ok: false, reason: 'html_rejected' };
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'source_failure' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
