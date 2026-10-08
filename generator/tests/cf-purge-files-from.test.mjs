/**
 * Un elenco di purge non viaggia sulla riga di comando. Run with `node --test`.
 *
 * IL DIFETTO. L'8 ottobre 2026 la run 37816114972 di fast-publish-article ha
 * spinto 78 articoli sugli shard e si è fermata al passo dopo: «/usr/bin/bash:
 * Argument list too long», codice 126. I due passi di purge passavano l'intero
 * elenco in un solo argomento `--files=url1,url2,…`: 1.600 URL, 167.227 byte,
 * contro il limite di Linux di 131.072 byte per stringa d'argomento. Il purge
 * non è partito, la verifica di leggibilità è stata saltata e le pagine nuove
 * sono rimaste dietro la cache dell'edge (issue #2527).
 *
 * `cf-purge-cache.mjs` divide già l'elenco in chiamate da 30. Non serviva a
 * niente: l'elenco non arrivava allo script.
 *
 * PERCHE' UN TEST. Una pubblicazione normale porta 368 URL e non vede il
 * difetto: compare oltre una cinquantina di articoli, cioè nelle
 * ripubblicazioni a lotti, a pagine già fuori. Qui lo script gira davvero, con
 * un elenco più lungo di quanto un argomento possa portare, contro un
 * Cloudflare finto che registra ogni chiamata.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { VARY_ORIGINS } from '../../scripts/lib/cf-purge-variants.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const SCRIPT = join(ROOT, 'scripts/cf-purge-cache.mjs');

// MAX_ARG_STRLEN di Linux: 32 pagine, 4 KiB l'una su x64.
const ARG_STRING_LIMIT = 131072;
const BATCH = 30;
const VARIANTS = 1 + VARY_ORIGINS.length;

// Il Cloudflare finto. Sostituisce `fetch` nel processo dello script e scrive
// ogni richiesta su un file, una riga per chiamata.
const CLOUDFLARE_STUB = `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init = {}) => {
  appendFileSync(
    process.env.PURGE_STUB_LOG,
    JSON.stringify({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null }) + '\\n',
  );
  return { status: 200, json: async () => ({ success: true, errors: [] }) };
};
`;

function workdir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-purge-files-from-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runPurge(dir, args, env = {}) {
  const stub = join(dir, 'cloudflare-stub.mjs');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(stub, CLOUDFLARE_STUB);
  writeFileSync(log, '');
  const res = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      CF_API_TOKEN: 'token-di-prova',
      CF_ZONE_ID: 'zona-di-prova',
      CF_PURGE_ORIGINS: VARY_ORIGINS.join(','),
      PURGE_STUB_LOG: log,
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { ...res, calls };
}

// La forma dell'elenco che il workflow costruisce: per ogni articolo la pagina
// e il ponte, in quattro lingue, sull'apex e sull'origine dello shard.
function publishedUrls(articles) {
  const sections = [
    ['it', 'articoli-frontaliere'],
    ['en', 'en/cross-border-articles'],
    ['de', 'de/grenzgaenger-artikel'],
    ['fr', 'fr/articles-frontalier'],
  ];
  const urls = [];
  for (let i = 0; i < articles; i++) {
    for (const [locale, prefix] of sections) {
      for (const rel of [`${prefix}/articolo-di-prova-numero-${i}/`, `${prefix}/articolo-di-prova-numero-${i}.html`]) {
        urls.push(`https://frontaliereticino.ch/${rel}`);
        urls.push(`https://origin-articolifrontaliere-${locale}.frontaliereticino.ch/${rel}`);
      }
    }
  }
  return urls;
}

// Che cosa è stato chiesto a Cloudflare, per variante di cache: l'elenco
// degli URL nell'ordine delle chiamate.
function purgedByVariant(calls) {
  const plain = [];
  const byOrigin = new Map(VARY_ORIGINS.map((origin) => [origin, []]));
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.match(call.url, /\/zones\/zona-di-prova\/purge_cache$/);
    const files = call.body.files;
    assert.ok(files.length >= 1 && files.length <= BATCH, `chiamata da ${files.length} URL`);
    if (typeof files[0] === 'string') {
      plain.push(...files);
      continue;
    }
    const origin = files[0].headers.Origin;
    assert.ok(byOrigin.has(origin), `variante inattesa: ${origin}`);
    for (const file of files) {
      assert.equal(file.headers.Origin, origin);
      byOrigin.get(origin).push(file.url);
    }
  }
  return { plain, byOrigin };
}

test('un elenco oltre il limite di un argomento arriva intero dal file', (t) => {
  const dir = workdir(t);
  const urls = publishedUrls(150);
  assert.ok(
    Buffer.byteLength(`--files=${urls.join(',')}`) > ARG_STRING_LIMIT,
    'il caso deve superare quello che un argomento può portare',
  );
  const list = join(dir, 'edge-purge-urls.txt');
  writeFileSync(list, `${urls.join('\n')}\n`);

  const res = runPurge(dir, [`--files-from=${list}`]);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.calls.length, Math.ceil(urls.length / BATCH) * VARIANTS);
  const { plain, byOrigin } = purgedByVariant(res.calls);
  assert.deepEqual(plain, urls, 'ogni URL una volta, nell\'ordine del file');
  for (const [origin, purged] of byOrigin) assert.deepEqual(purged, urls, `variante ${origin}`);
  assert.match(res.stdout, new RegExp(`purged for ${urls.length} URL\\(s\\)`));
});

test(
  'lo stesso elenco in un argomento non fa partire il processo',
  { skip: process.platform === 'linux' && process.arch === 'x64' ? false : 'limite per argomento del kernel Linux x64' },
  (t) => {
    const dir = workdir(t);
    const urls = publishedUrls(150);

    const res = runPurge(dir, [`--files=${urls.join(',')}`]);

    assert.equal(res.error?.code, 'E2BIG');
    assert.equal(res.calls.length, 0);
  },
);

test('le due sorgenti danno le stesse chiamate', (t) => {
  const dir = workdir(t);
  const urls = publishedUrls(4);
  const list = join(dir, 'urls.txt');
  writeFileSync(list, `${urls.join('\n')}\n`);

  const fromArgument = runPurge(dir, [`--files=${urls.join(',')}`]);
  const fromFile = runPurge(dir, [`--files-from=${list}`]);

  assert.equal(fromArgument.status, 0, fromArgument.stderr);
  assert.equal(fromFile.status, 0, fromFile.stderr);
  assert.equal(fromArgument.calls.length, Math.ceil(urls.length / BATCH) * VARIANTS);
  assert.deepEqual(fromFile.calls, fromArgument.calls);
});

test('righe vuote, spazi e fine riga di Windows non diventano URL', (t) => {
  const dir = workdir(t);
  const urls = publishedUrls(1);
  const list = join(dir, 'urls.txt');
  writeFileSync(list, `\n  ${urls.slice(0, 8).join('\r\n')}\r\n\n\n${urls.slice(8).join('  \n')}\n\n`);

  const res = runPurge(dir, [`--files-from=${list}`]);

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(purgedByVariant(res.calls).plain, urls);
});

test('un elenco che manca, vuoto o doppio ferma lo script prima di ogni chiamata', async (t) => {
  const dir = workdir(t);
  const empty = join(dir, 'vuoto.txt');
  writeFileSync(empty, '\n  \n\n');
  const some = join(dir, 'urls.txt');
  writeFileSync(some, 'https://frontaliereticino.ch/articoli-frontaliere/\n');
  const missing = join(dir, 'non-esiste.txt');

  const cases = [
    { name: 'file assente', args: [`--files-from=${missing}`], stderr: /non-esiste\.txt.*non leggibile \(ENOENT\)/ },
    { name: 'percorso di una cartella', args: [`--files-from=${dir}`], stderr: /non leggibile \(EISDIR\)/ },
    { name: 'file senza URL', args: [`--files-from=${empty}`], stderr: /--files-from= richiede almeno un URL/ },
    { name: 'percorso omesso', args: ['--files-from='], stderr: /richiede il percorso di un file/ },
    { name: 'argomento vuoto', args: ['--files='], stderr: /--files= richiede almeno un URL/ },
    {
      name: 'due sorgenti',
      args: [`--files-from=${some}`, '--files=https://frontaliereticino.ch/en/cross-border-articles/'],
      stderr: /una sola sorgente/,
    },
    // Un refuso nel nome del flag non deve diventare il purge dell'intera zona.
    { name: 'flag con un refuso', args: [`--file-from=${some}`], stderr: /Argomento non riconosciuto: --file-from=/ },
    { name: 'flag senza valore', args: ['--files-from'], stderr: /Argomento non riconosciuto: --files-from/ },
    { name: 'flag estraneo accanto a uno valido', args: [`--files-from=${some}`, '--tutto'], stderr: /Argomento non riconosciuto: --tutto/ },
  ];
  for (const { name, args, stderr } of cases) {
    // Con e senza token: il refuso del chiamante deve fermare la run anche
    // dove il purge sarebbe un no-op dichiarato.
    for (const token of ['token-di-prova', '']) {
      await t.test(`${name}${token ? '' : ' (senza token)'}`, () => {
        const res = runPurge(dir, args, { CF_API_TOKEN: token });
        assert.equal(res.status, 1, res.stdout + res.stderr);
        assert.match(res.stderr, stderr);
        assert.equal(res.calls.length, 0);
      });
    }
  }
});

test('senza argomenti resta il purge dell\'intera zona, in una chiamata sola', (t) => {
  const dir = workdir(t);

  const res = runPurge(dir, [], { CF_PURGE_SETTLE_MS: '1' });

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.calls.map((call) => call.body), [{ purge_everything: true }]);
});

// --- La regola sui chiamanti --------------------------------------------------

function shellFiles(dir, extensions) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules') continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...shellFiles(abs, extensions));
    else if (extensions.some((ext) => name.endsWith(ext))) out.push(abs);
  }
  return out;
}

// Un `--files=` il cui valore comincia con un'espansione della shell porta un
// elenco costruito a runtime, lungo quanto ciò che la run ha pubblicato. Un
// valore scritto per esteso ha il numero di URL che si legge nel file.
const LIST_BUILT_BY_THE_SHELL = /--files=["']?\$[({]/;

function shellBuiltLists() {
  const files = [
    ...shellFiles(join(ROOT, '.github/workflows'), ['.yml', '.yaml']),
    ...shellFiles(join(ROOT, 'scripts'), ['.sh']),
  ];
  const found = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (line.trimStart().startsWith('#')) return;
        if (!line.includes('cf-purge-cache.mjs') || !LIST_BUILT_BY_THE_SHELL.test(line)) return;
        found.push(`${file.slice(ROOT.length + 1)}:${index + 1}`);
      });
  }
  return found;
}

test('la regola riconosce le forme che portano un elenco costruito dalla shell', () => {
  for (const line of [
    'bash scripts/ci/retry-cmd.sh node scripts/cf-purge-cache.mjs "--files=$(IFS=,; echo "${urls[*]}")"',
    'node scripts/cf-purge-cache.mjs --files="$(IFS=,; echo "${purge_urls[*]}")"',
    'node scripts/cf-purge-cache.mjs --files=${URLS}',
    'node scripts/cf-purge-cache.mjs "--files=$(paste -sd, "$list")"',
  ]) assert.match(line, LIST_BUILT_BY_THE_SHELL, line);
  for (const line of [
    'bash scripts/ci/retry-cmd.sh node scripts/cf-purge-cache.mjs "--files-from=$RUNNER_TEMP/edge-purge-urls.txt"',
    'node scripts/cf-purge-cache.mjs --files="https://cdn.frontaliereticino.ch/images/blog/$ID.webp,https://cdn.frontaliereticino.ch/images/blog/thumbnails/$ID-480w.webp" || true',
  ]) assert.doesNotMatch(line, LIST_BUILT_BY_THE_SHELL, line);
});

test('nessun workflow e nessuno script di shell passa a --files= un elenco costruito a runtime', () => {
  assert.deepEqual(shellBuiltLists(), []);
});

test('i due passi di purge di fast-publish-article passano il file che il primo scrive', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/fast-publish-article.yml'), 'utf8');
  const calls = wf
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#') && line.includes('node scripts/cf-purge-cache.mjs'));
  assert.deepEqual(
    calls.map((line) => line.trim()),
    [
      'bash scripts/ci/retry-cmd.sh node scripts/cf-purge-cache.mjs "--files-from=$RUNNER_TEMP/edge-purge-urls.txt"',
      'bash scripts/ci/retry-cmd.sh node scripts/cf-purge-cache.mjs "--files-from=$list"',
    ],
  );
  assert.match(wf, /list="\$RUNNER_TEMP\/edge-purge-urls\.txt"/, 'il secondo passo legge lo stesso file');
});
