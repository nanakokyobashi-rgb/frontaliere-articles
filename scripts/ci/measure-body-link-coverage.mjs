#!/usr/bin/env node
/**
 * Copertura e precisione dei link nel corpo (F6.3b, gate O3 del piano §10.4):
 * prende gli N articoli piu' recenti dell'API pubblicata, legge il corpo reale da
 * `origin/main` del corpus e applica `enrichArticleInternalLinks` in memoria.
 * Strumento di SOLA MISURA: non scrive nel repo.
 *
 *   node scripts/ci/measure-body-link-coverage.mjs --repo <checkout corpus> --count 240 --output out.json
 *
 * `before` = link gia' presenti nel corpo salvato (nav: e landing lavoro);
 * `after` = con la F6.3b. Gli esempi riportano ancora, destinazione e frase,
 * da giudicare a mano (la precisione non e' misurabile da una regola).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { enrichArticleInternalLinks } from '../../generator/scripts/lib/contextual-article-links.mjs';

const API_BASE = process.env.SECTION_CADENCE_API_BASE || 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';
const BODY_DIR = (section) => (section === 'frontaliere' ? 'blog-body' : section === 'svizzera' ? 'blog-body-ch' : `blog-body-${section}`);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  return out;
}

async function json(name) {
  const res = await fetch(`${API_BASE}/${name}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; BodyLinkMeasure/1.0)' } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

/** Legge i campi `blog.article.<id>.bodyN` di un file di corpi. */
export function parseBodies(source, id) {
  const out = {};
  const re = new RegExp(`'blog\\.article\\.${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(body\\d+)':\\s*('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")`, 'g');
  for (const m of source.matchAll(re)) out[m[1]] = Function(`"use strict"; return ${m[2]};`)();
  return out;
}

function readBodies(repo, section, locale, id) {
  try {
    const src = execFileSync('git', ['-C', repo, 'show', `origin/main:content/${BODY_DIR(section)}/${locale}/${id}.ts`], { encoding: 'utf8', maxBuffer: 16e6, stdio: ['ignore', 'pipe', 'ignore'] });
    return parseBodies(src, id);
  } catch { return null; }
}

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
export function linksOf(text) { return [...text.matchAll(LINK)].map((m) => ({ anchor: m[1], target: m[2], index: m.index })); }
const kindOf = (t) => (t.startsWith('nav:') ? 'tool' : /^\/(?:(?:en|de|fr)\/)?(?:cerca-lavoro-|find-jobs-|jobs-in|jobs-im|trouver-emploi|lavoro-|jobs-|arbeit-|travail-)/.test(t) ? 'jobs' : /^\//.test(t) ? 'site' : 'other');

async function main() {
  const a = args(process.argv.slice(2));
  const repo = path.resolve(a.repo || '.');
  const count = Number(a.count || 240);
  const withLocales = Number(a.locales || 30);
  const lists = [['articles.json', 'frontaliere'], ['swiss-articles.json', 'svizzera'], ['canton-articles.json', null]];
  const pool = [];
  for (const [file, fixed] of lists) for (const x of await json(file)) pool.push({ id: x.id, date: x.date, section: fixed || x.section });
  pool.sort((p, q) => q.date.localeCompare(p.date));
  const rows = [];
  for (const art of pool) {
    if (rows.length >= count) break;
    const bodies = readBodies(repo, art.section, 'it', art.id);
    if (!bodies || !Object.keys(bodies).length) continue;
    const data = { content: { it: { ...bodies } } };
    for (const l of ['en', 'de', 'fr']) if (rows.length < withLocales) { const b = readBodies(repo, art.section, l, art.id); if (b && Object.keys(b).length) data.content[l] = { ...b }; }
    const original = structuredClone(data);
    enrichArticleInternalLinks(data, { isPending: () => false, bodySections: (c) => Object.fromEntries(Object.entries(c).filter(([k]) => /^body\d+$/.test(k))), sectionName: art.section, entityAnchors: Boolean(a['entity-anchors']) });
    const kinds = (content) => linksOf(Object.values(content).join('\n')).map((l) => kindOf(l.target));
    const beforeKinds = kinds(original.content.it); const afterKinds = kinds(data.content.it);
    const added = [];
    for (const locale of Object.keys(data.content)) {
      for (const [field, text] of Object.entries(data.content[locale])) {
        const had = new Set(linksOf(original.content[locale][field] || '').map((l) => l.target + l.anchor));
        for (const l of linksOf(text)) if (!had.has(l.target + l.anchor)) added.push({ locale, field, anchor: l.anchor, target: l.target, context: text.slice(Math.max(0, l.index - 90), l.index + l.anchor.length + l.target.length + 100).replace(/\s+/g, ' ') });
      }
    }
    rows.push({ id: art.id, section: art.section, date: art.date, before: beforeKinds, after: afterKinds, added: added.map((x) => ({ ...x, kind: kindOf(x.target) })) });
  }
  const share = (pred, f) => Math.round((rows.filter(pred).length / rows.length) * 1000) / 10;
  const bySection = {};
  for (const r of rows) (bySection[r.section.startsWith('canton-') ? 'cantoni' : r.section] ||= []).push(r);
  const summary = {
    sampled: rows.length,
    beforeWithToolOrJobs: share((r) => r.before.some((k) => k !== 'other')),
    afterWithToolOrJobs: share((r) => r.after.some((k) => k !== 'other')),
    beforeWithJobs: share((r) => r.before.includes('jobs')),
    afterWithJobs: share((r) => r.after.includes('jobs')),
    // Solo i link nuovi verso percorsi del sito (F6.3b); i `nav:` ri-applicati sono la logica storica.
    newDestinationLinkShare: share((r) => r.added.some((x) => x.locale === 'it' && x.kind !== 'tool')),
    newToolLinkShare: share((r) => r.added.some((x) => x.locale === 'it' && x.kind === 'tool')),
    maxInternalLinksAfter: Math.max(...rows.map((r) => r.after.filter((k) => k !== 'other').length)),
    internalOver4After: rows.filter((r) => r.after.filter((k) => k !== 'other').length > 4).length,
    internalOver4Before: rows.filter((r) => r.before.filter((k) => k !== 'other').length > 4).length,
    newLinkLocales: [...new Set(rows.flatMap((r) => r.added.filter((x) => x.kind !== 'tool').map((x) => x.locale)))],
    bySection: Object.fromEntries(Object.entries(bySection).map(([k, v]) => [k, { n: v.length, afterWithToolOrJobs: Math.round(v.filter((r) => r.after.some((x) => x !== 'other')).length / v.length * 1000) / 10, newDestinationLinkShare: Math.round(v.filter((r) => r.added.some((x) => x.locale === 'it' && x.kind !== 'tool')).length / v.length * 1000) / 10 }])),
  };
  const out = { summary, rows };
  if (a.output) fs.writeFileSync(a.output, `${JSON.stringify(out, null, 1)}\n`);
  console.log(JSON.stringify(summary, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
