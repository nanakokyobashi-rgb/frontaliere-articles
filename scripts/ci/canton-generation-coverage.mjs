import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  cantonSectionPaths,
  loadCantonSectionProfiles,
  resolveCantonSectionGate,
} from '../../generator/scripts/lib/canton-section-profile.mjs';
import { corpusPath } from '../../generator/scripts/lib/corpus-paths.mjs';
import { resolveKillSwitch } from '../lib/section-registry.mjs';
import { readTopLevelString, scanTopLevelArticleRecords } from '../lib/article-registry-reader.mjs';
import { readStaticObjectEntries } from '../lib/ts-literals.mjs';

const HOUR_MS = 3_600_000;
const LOCALE_WINDOW_HOURS = 48;
const ARTICLE_ID = /^[a-z0-9][a-z0-9-]*$/u;

export function measureCantonDry(profile, commits, now) {
  if (!commits?.available || !commits.perCanton) {
    return { status: 'unknown', detail: 'commit indisponibili' };
  }
  const hours = Math.max(2 * profile.cadenceHours, 18);
  const cutoff = now - hours * HOUR_MS;
  const canton = commits.perCanton[profile.section];
  const last = canton?.lastArticleAt;
  if (canton && last !== null && (!Number.isFinite(last) || last > now)) {
    return { status: 'unknown', detail: 'timestamp di pubblicazione indisponibile' };
  }
  const age = Number.isFinite(last) && last <= now
    ? `ultimo articolo ${((now - last) / HOUR_MS).toFixed(1)}h fa`
    : 'nessun articolo osservato';
  if (Number.isFinite(last) && last >= cutoff && last <= now) {
    return { status: 'covered', detail: `${age}, finestra ${hours}h` };
  }
  if (!Number.isFinite(commits.windowStart) || commits.windowStart > cutoff) {
    return { status: 'unknown', detail: `finestra commit inferiore a ${hours}h, ${age}` };
  }
  return { status: 'gap', detail: `nessun articolo nelle ultime ${hours}h, ${age}` };
}

function hasBody(file) {
  try {
    return statSync(file).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function measureCantonLocales(section, repoRoot, now) {
  const paths = cantonSectionPaths(section);
  const resolveFile = (rel) => path.join(repoRoot, corpusPath(rel));
  let ids;
  try {
    const registry = readFileSync(resolveFile(paths.registryFile), 'utf8');
    if (!registry.trim()) return { status: 'unknown', detail: 'registro vuoto' };
    ids = new Set(scanTopLevelArticleRecords(registry).filter((record) => {
      const date = Date.parse(readTopLevelString(record, 'date'));
      return ARTICLE_ID.test(record.id) && date >= now - LOCALE_WINDOW_HOURS * HOUR_MS && date <= now;
    }).map((record) => record.id));
  } catch {
    return { status: 'unknown', detail: 'registro indisponibile' };
  }

  // Una sezione senza pubblicazioni recenti non ha ancora un articolo da
  // confrontare fra i locali. `canton-dry` misura già questo caso; trattarlo
  // qui come quattro traduzioni mancanti produce un falso `locale-gap`.
  if (ids.size === 0) {
    return { status: 'no-article', detail: `nessun articolo nelle ultime ${LOCALE_WINDOW_HOURS}h` };
  }

  const counts = [];
  for (const metaFile of paths.metaFiles) {
    const locale = path.basename(metaFile, '.ts').slice(paths.metaPrefix.length + 1);
    try {
      const source = readFileSync(resolveFile(metaFile), 'utf8');
      if (!source.trim()) {
        counts.push([locale, null]);
        continue;
      }
      const titles = new Set();
      for (const { key, value } of readStaticObjectEntries(source)) {
        const id = /^blog\.article\.([a-z0-9-]+)\.title$/u.exec(key)?.[1];
        const title = value.trim();
        if (ids.has(id) && title && title !== key) titles.add(id);
      }
      const count = [...titles].filter((id) =>
        hasBody(resolveFile(`services/locales/${paths.bodyDir}/${locale}/${id}.ts`))).length;
      counts.push([locale, count]);
    } catch {
      counts.push([locale, null]);
    }
  }
  const detail = counts.map(([locale, count]) => `${locale}=${count ?? 'n/d'}`).join(', ');
  // I metadati di tutti i locali sono indispensabili per misurare la sezione.
  if (counts.some(([, count]) => count === null)) return { status: 'unknown', detail };
  const status = counts.some(([, count]) => count === 0) ? 'gap' : 'covered';
  return { status, detail: `${LOCALE_WINDOW_HOURS}h, ${detail}` };
}

function summarizeCantonCoverage(rows) {
  const labels = {
    inactive: 'inattivo', unknown: 'non misurabile',
    'no-article': 'nessun articolo nella finestra',
    gap: 'articolo assente nella finestra', covered: 'coperto',
  };
  const lines = rows.map(({ section, status, detail }) => `- ${section}: ${labels[status]} (${detail})`);
  const summary = lines.join('\n');
  if (rows.some(({ status }) => status === 'unknown')) return { summary, available: false };
  if (rows.some(({ status }) => status === 'gap')) return { summary, firing: true, body: summary };
  if (!rows.some(({ status }) => status === 'covered')) return { summary, available: false };
  return { summary, firing: false };
}

export function collectCantonGenerationCoverage({ now, repoRoot, commits, env = process.env }) {
  const profiles = loadCantonSectionProfiles();
  const kill = resolveKillSwitch(env);
  const dry = [];
  const locales = [];
  for (const profile of profiles.cantons) {
    const { section } = profile;
    let shared;
    if (kill.state !== 'verified') shared = { status: 'unknown', detail: 'Remote Config non verificato' };
    else if (!resolveCantonSectionGate(section, { env, profiles }).enabled || kill.sections.includes(section)) {
      shared = { status: 'inactive', detail: 'profilo o gate disabilitato, oppure kill switch attivo' };
    }
    dry.push({ section, ...(shared ?? measureCantonDry(profile, commits, now)) });
    locales.push({ section, ...(shared ?? measureCantonLocales(section, repoRoot, now)) });
  }
  return {
    'canton-dry': summarizeCantonCoverage(dry),
    'locale-gap': summarizeCantonCoverage(locales),
  };
}
