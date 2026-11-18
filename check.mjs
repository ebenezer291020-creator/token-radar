// Local gate checker: all 7 scorer rows, no judge call. Run: node check.mjs [snapshot] [outdir]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const vendor = fileURLToPath(new URL('./vendor/makefun-board.ts', import.meta.url));
const { buildDossier } = await import(vendor);

const snapDir = process.argv[2] ?? '/root/makefun/token-radar-01-kit/input/snapshot.json';
const out = process.argv[3] ?? fileURLToPath(new URL('./out', import.meta.url));
const snap = JSON.parse(readFileSync(snapDir, 'utf8'));
const results = [];
const gate = (name, ok, detail) => results.push({ name, ok, detail });

// 1 dashboard_files
{
  const dir = join(out, 'dashboard');
  const names = [];
  const walk = (d, pre = '') => {
    for (const n of readdirSync(d)) {
      if (n.startsWith('.')) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, pre + n + '/'); else names.push(pre + n);
    }
  };
  walk(dir);
  const files = names.map((n) => ({ n, buf: readFileSync(join(dir, n)) }));
  const totalBytes = files.reduce((a, f) => a + f.buf.length, 0);
  const hasHtml = files.some((f) => f.n === 'index.html');
  const hasCss = files.some((f) => extname(f.n) === '.css');
  const hasJs = files.some((f) => extname(f.n) === '.js');
  const nameOk = files.every((f) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(f.n.split('/').pop()) && !f.n.split('/').some((s) => s.startsWith('.')));
  let net = null;
  const scanHtmlAttrs = (html) => {
    // attribute values
    const attrRe = /=\s*("([^"]*)"|'([^']*)')/g; let m;
    while ((m = attrRe.exec(html))) {
      const v = m[2] ?? m[3] ?? '';
      if (/https?:\/\//i.test(v)) return v.slice(0, 80);
    }
    // <style> bodies
    const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    while ((m = styleRe.exec(html))) if (/https?:\/\//i.test(m[1])) return m[1].slice(0, 80);
    return null;
  };
  const jsSpecRe = /(?:import|export\s+[^;]*?\sfrom|require)\s*\(?\s*["']([^"']+)["']/g;
  for (const f of files) {
    const text = f.buf.toString('utf8');
    if (extname(f.n) === '.html') { const hit = scanHtmlAttrs(text); if (hit) net = `${f.n}: ${hit}`; }
    if (extname(f.n) === '.css' && /https?:\/\//i.test(text)) net = `${f.n}: css url`;
    if (extname(f.n) === '.js') {
      let m; const specRe = /(?:import\s*[^;]*?from\s*|import\s*|export\s*[^;]*?from\s*|require\s*\(\s*|import\s*\(\s*)(["'])([^"']+)\1/g;
      while ((m = specRe.exec(text))) if (/https?:\/\//i.test(m[2])) net = `${f.n}: ${m[2]}`;
    }
  }
  gate('dashboard_files', hasHtml && hasCss && hasJs && files.length <= 400 && totalBytes <= 4 * 1024 * 1024 && nameOk && !net,
    `${files.length} files, ${totalBytes} bytes, net=${net ?? 'none'}`);
}

// 2 board_file
let rows;
{
  const buf = readFileSync(join(out, 'board.json'));
  const doc = JSON.parse(buf.toString('utf8'));
  rows = Array.isArray(doc) ? doc : doc.rows;
  const slugs = new Set(snap.protocols.map((p) => p.slug));
  const bad = [];
  if (!Array.isArray(rows) || rows.length < 100 || rows.length > 4000) bad.push(`row count ${rows?.length}`);
  if (buf.length > 8 * 1024 * 1024) bad.push(`bytes ${buf.length}`);
  for (const r of rows) {
    if (!slugs.has(r.slug)) bad.push(`invented slug ${r.slug}`);
    if (typeof r.name !== 'string' || !r.name) bad.push(`${r.slug} name`);
    if (!Number.isSafeInteger(r.rank) || r.rank <= 0) bad.push(`${r.slug} rank`);
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) bad.push(`${r.slug} implied`);
    if (!Array.isArray(r.farm_steps)) bad.push(`${r.slug} farm_steps`);
  }
  gate('board_file', bad.length === 0, `${rows.length} rows, ${buf.length} bytes, ${bad.length ? bad.slice(0, 3).join('; ') : 'ok'}`);
}

// 3 sorted_by_value
{
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  let ok = ranks.every((v, i) => v === i + 1);
  for (let i = 1; i < rows.length; i++) if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) ok = false;
  const distinct = new Set(rows.map((r) => r.implied_value_usd));
  if (rows.length >= 2 && distinct.size === 1) ok = false;
  gate('sorted_by_value', ok, `ranks 1..${rows.length}, ${distinct.size} distinct implied values, monotone=${ok}`);
}

// 4 coverage
{
  const slugs = new Set(rows.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  gate('coverage', missing.length === 0, `${snap.watchlist.length - missing.length}/${snap.watchlist.length} watchlist covered`);
}

// 5 farm_steps
{
  let bad = 0;
  for (const r of rows) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) bad++;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (typeof s !== 'string' || t.length < 20 || t.length > 600) bad++;
    }
  }
  gate('farm_steps', bad === 0, `${bad} bad rows`);
}

// 6 screenshots
{
  const dir = join(out, 'screenshots');
  const names = readdirSync(dir).filter((n) => !n.startsWith('.'));
  const bad = [];
  if (names.length < 3 || names.length > 4) bad.push(`count ${names.length}`);
  for (const n of names) {
    const buf = readFileSync(join(dir, n));
    if (buf.length > 512 * 1024) bad.push(`${n} ${buf.length}B`);
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(n)) bad.push(`${n} name`);
    const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
    if (!png && !jpg) bad.push(`${n} not whole PNG/JPEG`);
    let w = 0, h = 0;
    if (png) { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); }
    else { // scan JPEG SOF
      let i = 2;
      while (i < buf.length - 8) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break;
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    const long = Math.max(w, h), short = Math.min(w, h);
    if (long > 1440 || short < 800) bad.push(`${n} ${w}x${h}`);
  }
  gate('screenshots', bad.length === 0, `${names.length} images, ${bad.length ? bad.join('; ') : 'dims+size ok'}`);
}

// 7 dossier_matches
{
  const buf = readFileSync(join(out, 'dossier.json'));
  const rebuilt = buildDossier(out, { text_max_bytes: 65_536 });
  const same = Buffer.from(rebuilt).equals(buf);
  gate('dossier_matches', same && buf.length <= 1.5 * 1024 * 1024, `dossier ${buf.length}B, byte-identical rebuild=${same}`);
}

let fail = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`); if (!r.ok) fail++; }
console.log(fail === 0 ? 'ALL 7 GATES PASS' : `${fail} GATE(S) FAIL`);
process.exit(fail === 0 ? 0 : 1);
