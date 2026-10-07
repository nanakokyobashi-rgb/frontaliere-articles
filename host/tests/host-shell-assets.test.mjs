/**
 * host-shell-assets.test.mjs — la shell trasportata non nomina un file che il
 * pubblicatore non sa mettere sulla CDN (sito issue 12270).
 *
 * IL DIFETTO. Il 2026-10-07 il sito ha dato a `gtag-init` un nome derivato dal
 * contenuto (`/assets/gtag-init-<hash>.js`). I suoi emettitori veloci hanno
 * pubblicato quel riferimento in pochi minuti; il file sarebbe arrivato sulla
 * CDN solo con il deploy completo, ore dopo. Ogni articolo rirenderizzato ha
 * caricato un 404 al posto del `page_view` statico di GA4 per 2 h 40 min.
 *
 * PERCHE' QUI. Le pagine di questo repo prendono la shell da `host/`, copia
 * trasportata di quella del sito. Appena il contratto con il nome nuovo arriva
 * qui, ogni articolo pubblicato lo referenzia, e questo repo non ha un build
 * che carichi il file: lo deve garantire il pubblicatore, prima del push.
 *
 * Gira sotto tsx (`host/tests/`, vedi generator-ci.yml): importa
 * `host/constants.ts`, che un `node --test` nudo non sa leggere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostShellFiles, main } from '../../scripts/ci/ensure-host-shell-assets.mjs';
import { ensureCdnShellAssets, shellAssetsFromStaticScripts } from '../../scripts/lib/cdn-shell-assets.mjs';
import { normalizeContractEnv } from './shell-contract-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const ENSURE_SCRIPT = 'scripts/ci/ensure-host-shell-assets.mjs';

// Stessa ragione di shell-contract-fingerprint.test.mjs: `cdnPreconnectHint`
// dipende da ASSET_CDN al caricamento del modulo.
normalizeContractEnv();

/** Una CDN e un bucket che contengono `stored`, nei tre collaboratori che la libreria accetta. */
function fakeCdn(stored, { probeAnswer, storeAnswer, uploadWorks = true } = {}) {
  const bucket = new Set(stored);
  const calls = { checkStored: [], upload: [] };
  return {
    bucket,
    calls,
    probe: async (key) => (probeAnswer ? probeAnswer(key) : bucket.has(key) ? 'present' : 'absent'),
    checkStored: (key) => {
      calls.checkStored.push(key);
      return storeAnswer ? storeAnswer(key) : bucket.has(key) ? 'exists' : 'missing';
    },
    upload: (key, content) => {
      calls.upload.push([key, content]);
      if (uploadWorks) bucket.add(key);
      return uploadWorks;
    },
    log: () => {},
  };
}

// ── 1. Che cosa questo repo sa pubblicare ─────────────────────────────────

test('ogni file della shell che host/ porta ha il nome derivato dal proprio contenuto', () => {
  const files = hostShellFiles();
  assert.ok(files.length >= 1, 'nessun file della shell da garantire');
  for (const [name, content] of files) {
    const digest = createHash('sha256').update(content).digest('hex');
    assert.ok(name.includes(digest.slice(0, 12)), `${name} non porta l'impronta del proprio contenuto (${digest.slice(0, 12)})`);
  }
});

test('ogni riferimento con nome derivato dal contenuto nel contratto e\' un file che questo repo sa pubblicare', async () => {
  const { contract } = await import('../siteShellBootstrap.ts');
  const publishable = new Set(hostShellFiles().map(([name]) => name));
  const referenced = new Set();
  for (const value of Object.values(contract)) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/\/assets\/([A-Za-z0-9._-]+-[0-9a-f]{12}\.(?:m?js|css))/g)) referenced.add(match[1]);
  }
  // Non vuoto: se il contratto smette di avere riferimenti di questo tipo il
  // test deve dirlo, non passare senza guardare niente.
  assert.ok(referenced.size >= 1, 'il contratto non contiene piu\' riferimenti con nome derivato dal contenuto');
  for (const name of referenced) {
    assert.ok(
      publishable.has(name),
      `il contratto referenzia /assets/${name} ma host/ non ne porta il contenuto: nessun passo puo' garantirlo sulla CDN`,
    );
  }
});

test('lo script d\'ingresso passa alla libreria proprio quei file', async () => {
  let received = null;
  await main({ ensure: async ({ assets }) => { received = assets; return []; } });
  assert.deepEqual(received, shellAssetsFromStaticScripts(hostShellFiles()));
  assert.ok(received.every((asset) => asset.key.startsWith('assets/')));
});

// ── 2. La decisione, sul gemello del sito ─────────────────────────────────

test('IL CASO: il file che la CDN non ha viene caricato, con il contenuto di host/', async () => {
  const assets = shellAssetsFromStaticScripts(hostShellFiles());
  const cdn = fakeCdn([]);
  const results = await ensureCdnShellAssets({ assets, ...cdn });
  assert.deepEqual(cdn.calls.upload, assets.map((asset) => [asset.key, asset.content]));
  assert.deepEqual(results.map((result) => result.outcome), assets.map(() => 'uploaded'));
});

test('un file servito non fa leggere R2 ne\' caricare niente', async () => {
  const assets = shellAssetsFromStaticScripts(hostShellFiles());
  const cdn = fakeCdn(assets.map((asset) => asset.key));
  await ensureCdnShellAssets({ assets, ...cdn });
  assert.deepEqual(cdn.calls.checkStored, []);
  assert.deepEqual(cdn.calls.upload, []);
});

test('un runner respinto dall\'edge non sostituisce un oggetto che R2 ha', async () => {
  const assets = shellAssetsFromStaticScripts(hostShellFiles());
  const cdn = fakeCdn(assets.map((asset) => asset.key), { probeAnswer: () => 'unknown' });
  const results = await ensureCdnShellAssets({ assets, ...cdn });
  assert.deepEqual(cdn.calls.upload, []);
  assert.deepEqual(results.map((result) => result.outcome), assets.map(() => 'stored'));
});

test('se non si puo\' stabilire che il file ci sia, il job si ferma senza caricare', async () => {
  const assets = shellAssetsFromStaticScripts(hostShellFiles());
  for (const cdn of [
    fakeCdn([], { storeAnswer: () => 'indeterminate' }),
    fakeCdn([], { uploadWorks: false }),
  ]) {
    await assert.rejects(() => ensureCdnShellAssets({ assets, ...cdn }), /must not be published/);
  }
});

// ── 3. Chi pubblica esegue il passo, prima ────────────────────────────────

/** I job di un workflow, ciascuno con i suoi step ridotti alle righe eseguibili. */
function jobsOf(source) {
  const lines = source.split('\n');
  const jobs = [];
  let job = null;
  let step = null;
  for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      job = { name: header[1], steps: [] };
      jobs.push(job);
      step = null;
      continue;
    }
    if (!job) continue;
    if (/^ {6}- /.test(line)) {
      step = { lines: [] };
      job.steps.push(step);
    }
    // I commenti citano gli script e li farebbero sembrare eseguiti.
    if (step && !line.trim().startsWith('#')) step.lines.push(line);
  }
  return jobs.map((entry) => ({ name: entry.name, steps: entry.steps.map((s) => s.lines.join('\n')) }));
}

const escapeRx = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const invocationOf = (paths) => new RegExp(
  String.raw`(?:^|[\s;&|(])(?:node|bash|tsx(?:@[\w.]+)?)\s+(?:${paths.map(escapeRx).join('|')})(?![\w.-])`,
  'm',
);

// Gli emettitori, ricavati dal codice: uno script di primo livello che importa
// il pipeline di rendering rende pagine con la shell di host/.
const renderers = readdirSync(path.join(ROOT, 'scripts'))
  .filter((name) => name.endsWith('.mjs'))
  .filter((name) => /from '\.\/lib\/article-render-pipeline\.mjs'/.test(read(`scripts/${name}`)))
  .map((name) => `scripts/${name}`);
const renders = invocationOf(renderers);
const ensures = invocationOf([ENSURE_SCRIPT]);

const renderingJobs = [];
for (const workflow of readdirSync(path.join(ROOT, '.github/workflows')).filter((name) => /\.ya?ml$/.test(name))) {
  for (const job of jobsOf(read(`.github/workflows/${workflow}`))) {
    if (job.steps.some((step) => renders.test(step))) renderingJobs.push({ workflow, ...job });
  }
}

test('gli emettitori trovati sono quelli che questo repo ha oggi', () => {
  assert.ok(renderers.includes('scripts/publish-article-fast.mjs'), renderers.join(', '));
  assert.ok(renderers.includes('scripts/publish-section-pages.mjs'), renderers.join(', '));
  const workflows = renderingJobs.map((job) => job.workflow);
  assert.ok(workflows.includes('fast-publish-article.yml'), workflows.join(', '));
  assert.ok(workflows.includes('fast-publish-section.yml'), workflows.join(', '));
});

test('ogni job che rende pagine con la shell esegue prima il passo, e non puo\' ignorarne l\'esito', () => {
  const offenders = [];
  for (const { workflow, name, steps } of renderingJobs) {
    const firstRender = steps.findIndex((step) => renders.test(step));
    const ensure = steps.findIndex((step) => ensures.test(step));
    if (ensure === -1) {
      offenders.push(`${workflow} › ${name}: rende pagine senza eseguire ${ENSURE_SCRIPT}`);
      continue;
    }
    if (ensure > firstRender) offenders.push(`${workflow} › ${name}: esegue ${ENSURE_SCRIPT} dopo il primo emettitore`);
    if (/^\s*continue-on-error:\s*true\b/m.test(steps[ensure])) offenders.push(`${workflow} › ${name}: il passo e' continue-on-error`);
    if (/ensure-host-shell-assets\.mjs[^\n]*\|\|/.test(steps[ensure])) offenders.push(`${workflow} › ${name}: il passo scarta il proprio esito`);
  }
  assert.deepEqual(offenders, []);
});
