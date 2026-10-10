/**
 * rewire-json-contracts.test.mjs — i contratti JSON del REWIRE set,
 * inchiodati dal lato del CONSUMATORE (issue #101).
 *
 * ## Il buco che chiude
 *
 * Il sito pubblica artefatti su `cdn.frontaliereticino.ch/data/` e questo
 * repo li consuma. I due capi hanno nomi diversi e non si importano, quindi il
 * legame non e' visto da nessuno dei guard esistenti — ne' dal drift check (che
 * confronta per path), ne' dai closure test (che seguono gli import), ne' da
 * `loop-references-exist.test.mjs` (che verifica che un path citato ESISTA: la
 * sua esistenza non dice niente sulla sua forma). Il razionale completo, e le
 * coppie, stanno in `generator/tests/lib/rewire-contracts.mjs`.
 *
 * Prima di questo file, `generator/tests/` non conteneva una sola riga che
 * nominasse border-wait o events-dataset. Il sintomo di una rottura non era un
 * fallimento: era un ARTICOLO SBAGLIATO su una URL evergreen che gia' posiziona.
 *
 * ## Cosa questa suite prova, e cosa NO — leggerlo prima di fidarsi
 *
 * PROVA che la validazione dal lato consumatore accetta la forma registrata e
 * RIFIUTA ognuna delle deformazioni che contano, campo per campo. Il valore non
 * e' «il fixture combacia» (sarebbe rumore a ogni cambio di dato): e' che
 * indebolire un `refresh` — togliere un controllo, allentare una regex,
 * accettare una unita' diversa — smette di essere invisibile.
 *
 * NON PROVA che il produttore non sia cambiato. Il produttore sta sul sito e da
 * qui non e' pinnabile: un fixture e' una registrazione, e una registrazione non
 * si accorge di niente. Quella meta' e' `--check` contro i dati veri, che gira
 * in `.github/workflows/generator-ci.yml` sulle PR e a orologio in
 * `.github/workflows/rewire-contract-watch.yml`. Le due meta' guardano
 * direzioni opposte e servono entrambe.
 *
 * ## Perche' lo script viene COPIATO in una temp dir
 *
 * I `refresh` risolvono la propria cache da `import.meta.url`, non da `cwd`:
 * eseguirli in loco leggerebbe (e, senza `--check`, scriverebbe) le cache vere
 * del repo. Su `refresh-border-wait-averages.mjs` non e' teorico — la guardia
 * anti-shrink confronta col file di cache ESISTENTE, quindi su una macchina che
 * ha gia' fatto un refresh vero il fixture da 10 valichi verrebbe rifiutato per
 * un motivo che col contratto non c'entra. Copiare lo script alla stessa
 * profondita' relativa dentro una temp dir rende la suite ermetica e permette di
 * esercitare anche il ramo di SCRITTURA, che e' quello che produce il file che
 * `borderCrossings.ts` legge davvero.
 *
 * La copia e' fedele se gli import relativi vengono copiati insieme allo
 * script (rewire-fetch.mjs e' il primo). Un import di pacchetto npm resterebbe
 * invisibile: c'e' un test qui sotto che lo tiene fermo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REWIRE_CONTRACTS, contract, freshenGeneratedAt, freshenRecording, freshenWindow, freshenYear } from './lib/rewire-contracts.mjs';
import { fetchFirstOk } from '../scripts/lib/rewire-fetch.mjs';
import { fetchFirstValidBorderWaitAverages } from '../scripts/lib/border-wait-averages.mjs';
import {
  fetchFirstValidRoadEvents,
  isRoadEventsTimestampInWindow,
  isValidRoadEventsPayload,
  validateRoadEventsPayload,
} from '../scripts/refresh-road-events.mjs';
import { rankingFromStats, trendFromStats, MIN_SAMPLES_FOR_RANKING } from '../scripts/lib/border-wait-ranking.mjs';
import { importSpecifiers, relativeImportSpecifiers } from '../../scripts/ci/lib/import-specifiers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readFixture = (c) => JSON.parse(read(c.fixture));

/** Oggi, come lo vedono i gate temporali dei `refresh`. */
const TODAY = new Date().toISOString().slice(0, 10);

/** Anno di calendario dei gate di staleness dei dataset annuali (fisco, pensioni). */
const CURRENT_YEAR = new Date().getUTCFullYear();

/**
 * Il payload registrato, rimesso in data quando il contratto lo richiede:
 * border-wait window (finestra settimanale), carburanti per cantone e road-events
 * (`generatedAt`) e i contratti con `freshen` (timestamp traslati o anno
 * corrente, vedi `freshenRecording`); road-events usa anch'esso `generatedAt`.
 */
function servable(c) {
  const payload = readFixture(c);
  if (c.id === 'border-wait-window') return freshenWindow(payload, TODAY);
  if (c.id === 'fuel-cantons' || c.id === 'road-events') return freshenGeneratedAt(payload, new Date().toISOString());
  return c.freshen ? freshenRecording(c, payload) : payload;
}

/**
 * Gli altri contratti che hanno lo STESSO consumatore (l'aggregatore dei
 * servizi legge quattro artefatti): mentre se ne esercita uno, gli altri tre
 * vanno serviti dai loro fixture, altrimenti il test leggerebbe la CDN vera e
 * smetterebbe di essere ermetico.
 */
const siblingsOf = (c) => REWIRE_CONTRACTS.filter((o) => o.id !== c.id && o.consumer.refresh === c.consumer.refresh);

/**
 * Messaggio di fallimento che dice la DIREZIONE, non solo che qualcosa non
 * combacia. Un rosso che si legge «un JSON non corrisponde» costa mezz'ora a
 * chiunque lo trovi; questo dice quale contratto, quali due file lo reggono, e
 * cosa succede in produzione se si sbaglia a chiuderlo.
 */
function why(c, detail) {
  return [
    `CONTRATTO REWIRE: ${c.artifact}`,
    `  produttore : ${c.producer.repo} → ${c.producer.path}   (NON modificabile da qui)`,
    `  consumatore: ${c.consumer.refresh}`,
    `  fallimento : ${c.failureMode === 'hard' ? 'hard gate' : 'soft (overlay cosmetico)'}`,
    `  sintomo    : ${c.symptom}`,
    '',
    detail,
    '',
    'Due modi di arrivare qui, e la fix e\' diversa:',
    '  1. hai cambiato il consumatore (o la sua validazione) → e\' il test che sta',
    '     facendo il suo lavoro: aggiorna registro + fixture NELLO STESSO commit e',
    '     scrivi nel body della PR cosa e\' cambiato nella forma.',
    '  2. il SITO ha cambiato la forma dell\'artefatto → il fixture qui non se ne',
    '     accorge da solo (e\' una registrazione). Se ci sei arrivato da un rosso di',
    '     `rewire-contract-watch.yml`, la fix vera va concordata col produttore:',
    `     ${c.producer.path} sul repo ${c.producer.repo}.`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Armatura: server locale + copia isolata dello script di refresh
// ─────────────────────────────────────────────────────────────────────────────

/** Serve un corpo fisso su 127.0.0.1, porta effimera. */
async function serve(body, { status = 200, contentType = 'application/json' } = {}) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': contentType });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/data.json`;
  return { url, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Copia uno script di refresh e i suoi import relativi, stessa profondita'.
 * Senza questo, `from './lib/rewire-fetch.mjs'` nella copia in temp dir
 * non risolverebbe e la suite smetterebbe di esercitare il file vero.
 */
function copyRefreshTree(root, rel) {
  const src = path.join(ROOT, rel);
  const dest = path.join(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const text = fs.readFileSync(src, 'utf8');
  for (const spec of relativeImportSpecifiers(text)) {
    const childRel = path.normalize(path.join(path.dirname(rel), spec));
    copyRefreshTree(root, childRel);
  }
  return dest;
}

/**
 * Esegue il `refresh` di un contratto contro un corpo servito in locale.
 * Ritorna `{ status, out, root }` — `root` e' la temp dir, cosi' il chiamante
 * puo' ispezionare la cache scritta.
 */
async function runRefresh(c, body, { check = true } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), `rewire-${c.id}-`));
  const script = copyRefreshTree(root, c.consumer.refresh);

  const served = await serve(body);
  const siblings = await Promise.all(siblingsOf(c).map(async (o) => ({ o, srv: await serve(asBody(servable(o))) })));
  const siblingEnv = Object.fromEntries(siblings.map(({ o, srv }) => [o.consumer.envUrl, srv.url]));
  try {
    // `spawn` e non `spawnSync`: il server sta in QUESTO processo, e una spawn
    // sincrona blocca l'event loop — la richiesta del figlio non verrebbe mai
    // servita e ogni caso finirebbe in timeout. Costa mezz'ora di diagnosi
    // trovarlo, perche' il sintomo e' «i test sono lenti», non «sbagliati».
    const res = await new Promise((resolve) => {
      const child = spawn(process.execPath, check ? [script, '--check'] : [script], {
        env: { ...process.env, ...siblingEnv, [c.consumer.envUrl]: served.url },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, out });
      });
    });
    return { ...res, root };
  } finally {
    await served.close();
    await Promise.all(siblings.map(({ srv }) => srv.close()));
  }
}

const asBody = (payload) => JSON.stringify(payload);

/** Copia profonda del payload servibile, per mutarlo senza toccare il fixture. */
const mutated = (c, fn) => {
  const payload = structuredClone(servable(c));
  const out = fn(payload);
  return asBody(out === undefined ? payload : out);
};

test('[rewire-fetch] un body non JSON prova la sorgente successiva prima del parse del consumer', async () => {
  const calls = [];
  const result = await fetchFirstOk(['primary', 'fallback'], {
    getBody: async (url) => {
      calls.push(url);
      return url === 'primary' ? '{malformed json' : '{"valid":true}';
    },
  });

  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.equal(result.ok, true);
  assert.equal(result.url, 'fallback');
  assert.deepEqual(result.payload, { valid: true });
  assert.match(result.errors[0], /primary is not valid JSON/);

  const noValidJson = await fetchFirstOk(['only-source'], {
    getBody: async () => '{still malformed',
  });
  assert.equal(noValidJson.ok, true);
  assert.equal(noValidJson.url, 'only-source');
  assert.equal(noValidJson.payload, undefined);
  assert.match(noValidJson.body, /still malformed/);
});

test('[rewire-fetch] un HTTP 200 vuoto conta come risposta e non come publisher irraggiungibile', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '' });
  try {
    const result = await fetchFirstOk(['empty-200'], {
      retries: 1,
      validate: () => 'empty body is not a dataset',
    });

    assert.equal(result.ok, false);
    assert.equal(result.sawResponse, true);
    assert.match(result.errors[0], /empty-200 is not valid JSON/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('[road-events] un HTTP 200 malformato non impedisce il fallback valido', async () => {
  const now = Date.now();
  const payload = structuredClone(servable(contract('road-events')));
  payload.generatedAt = new Date(now).toISOString();
  const calls = [];
  const result = await fetchFirstValidRoadEvents(['primary', 'fallback'], {
    now,
    getBody: async (url) => {
      calls.push(url);
      return url === 'primary' ? '{malformed json' : JSON.stringify(payload);
    },
  });

  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.equal(result.ok, true);
  assert.equal(result.url, 'fallback');
  assert.equal(result.payload.generatedAt, payload.generatedAt);
  assert.match(result.errors[0], /primary is not valid JSON/);
});

test('[road-events] un payload JSON non valido continua sul fallback e non viene ammesso', async () => {
  const now = Date.now();
  const payload = structuredClone(servable(contract('road-events')));
  payload.generatedAt = new Date(now).toISOString();
  const result = await fetchFirstValidRoadEvents(['primary', 'fallback'], {
    now,
    getBody: async (url) => JSON.stringify(url === 'primary' ? { schemaVersion: 2 } : payload),
  });

  assert.equal(result.ok, true);
  assert.equal(result.url, 'fallback');
  assert.match(result.errors[0], /schemaVersion is 2, expected 1/);

  const rejected = await fetchFirstValidRoadEvents(['primary'], {
    now,
    getBody: async () => JSON.stringify({ schemaVersion: 2 }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.sawResponse, true);
  assert.match(rejected.errors[0], /schemaVersion is 2, expected 1/);
});

test('[road-events] la finestra dei 48h usa l’orologio dopo il fetch', async () => {
  const startedAt = Date.UTC(2026, 9, 10, 12);
  const originalNow = Date.now;
  let currentNow = startedAt;
  Date.now = () => currentNow;
  try {
    const payload = structuredClone(servable(contract('road-events')));
    payload.generatedAt = new Date(startedAt - 48 * 3_600_000).toISOString();
    const result = await fetchFirstValidRoadEvents(['delayed-primary'], {
      getBody: async () => {
        currentNow = startedAt + 1;
        return JSON.stringify(payload);
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.sawResponse, true);
    assert.match(result.errors[0], /refusing stale road events/);
  } finally {
    Date.now = originalNow;
  }
});

test('[border-wait-averages] una risposta 200 non valida passa alla source di fallback', async () => {
  const payload = servable(contract('border-wait-averages'));
  const calls = [];
  const result = await fetchFirstValidBorderWaitAverages(['primary', 'fallback'], {
    previousCount: 0,
    getBody: async (url) => {
      calls.push(url);
      return url === 'primary'
        ? JSON.stringify({ 'chiasso-brogeda': { morning: 15 } })
        : JSON.stringify(payload);
    },
  });

  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.equal(result.ok, true);
  assert.equal(result.url, 'fallback');
  assert.match(result.errors[0], /not a "N min" or "N-M min" range/);
});

test('[road-events] la finestra temporale include esattamente -1h e 48h', () => {
  const now = Date.UTC(2026, 9, 10, 12);
  const atFutureBoundary = new Date(now + 3_600_000).toISOString();
  const atOldBoundary = new Date(now - 48 * 3_600_000).toISOString();
  const futureOutside = new Date(now + 3_600_001).toISOString();
  const oldOutside = new Date(now - 48 * 3_600_000 - 1).toISOString();

  assert.equal(isRoadEventsTimestampInWindow(atFutureBoundary, now), true);
  assert.equal(isRoadEventsTimestampInWindow(atOldBoundary, now), true);
  assert.equal(isRoadEventsTimestampInWindow(futureOutside, now), false);
  assert.equal(isRoadEventsTimestampInWindow(oldOutside, now), false);

  const payload = structuredClone(servable(contract('road-events')));
  payload.generatedAt = atOldBoundary;
  assert.equal(isValidRoadEventsPayload(payload, { now }), true);
  payload.generatedAt = oldOutside;
  assert.match(validateRoadEventsPayload(payload, { now }), /is \d+h old — refusing stale road events/);
});

test('[road-events] la validazione combinata rifiuta duplicato, semicantone e intervallo invertito', () => {
  const payload = structuredClone(servable(contract('road-events')));
  const index = payload.events.findIndex((event, i) => i > 0 && event.validFrom && event.validTo);
  assert.ok(index > 0, 'il fixture deve avere un secondo record con entrambe le date');
  payload.events[index].id = payload.events[0].id;
  payload.events[index].canton = 'BL';
  [payload.events[index].validFrom, payload.events[index].validTo] = [
    payload.events[index].validTo,
    payload.events[index].validFrom,
  ];

  assert.equal(isValidRoadEventsPayload(payload), false);
  assert.match(validateRoadEventsPayload(payload), /is duplicated — refusing/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Il registro non deve poter marcire
// ─────────────────────────────────────────────────────────────────────────────

test('ogni contratto dichiarato ha i suoi file: refresh, fixture, consumatori', () => {
  assert.equal(
    REWIRE_CONTRACTS.length,
    12,
    'il REWIRE set e\' di dodici artefatti: i tre della issue #101, i carburanti per cantone (P9b), gli avvisi cantonali (P9g), i quattro input dei servizi (P9f), road-events (P9c) e i dataset annuali fisco e pensioni (P9d/P9e)',
  );
  const missing = [];
  for (const c of REWIRE_CONTRACTS) {
    for (const rel of [c.consumer.refresh, c.fixture, ...c.readBy.map((r) => r.file)]) {
      if (!fs.existsSync(path.join(ROOT, rel))) missing.push(`${c.id}: ${rel}`);
    }
  }
  assert.deepEqual(missing, [], `File dichiarati nel registro REWIRE e assenti:\n  ${missing.join('\n  ')}`);
});

test('ogni refresh importa solo builtin Node o path relativi — la copia in temp dir li porta', () => {
  const offenders = [];
  for (const c of REWIRE_CONTRACTS) {
    const src = read(c.consumer.refresh);
    for (const spec of importSpecifiers(src)) {
      if (spec.startsWith('node:') || spec.startsWith('.')) continue;
      offenders.push(`${c.consumer.refresh} → ${spec}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Un `refresh` importa un pacchetto o un path non relativo.\n' +
      'Questa suite lo COPIA in una temp dir (script + import relativi) per isolarne\n' +
      'la cache: un `from \'undici\'` (o simile) non verrebbe copiato e il test\n' +
      'smetterebbe di esercitare il file vero. Se serve una dipendenza, l\'armatura\n' +
      `va cambiata insieme:\n  ${offenders.join('\n  ')}`,
  );
});

test('ogni campo dichiarato letto esiste nel fixture ED e\' nominato dal file che lo legge', () => {
  const problems = [];
  const keysOf = (node, acc = new Set()) => {
    if (Array.isArray(node)) node.forEach((v) => keysOf(v, acc));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        acc.add(k);
        keysOf(v, acc);
      }
    }
    return acc;
  };
  // Confine di parola: senza, `comune` combacerebbe dentro `groupByComune` e il
  // controllo sarebbe un timbro.
  const namesField = (src, field) => new RegExp(`(?<![A-Za-z0-9_$])${field}(?![A-Za-z0-9_$])`).test(src);

  for (const c of REWIRE_CONTRACTS) {
    const keys = keysOf(readFixture(c));
    for (const { file, fields } of c.readBy) {
      const src = read(file);
      for (const field of fields) {
        if (!keys.has(field)) problems.push(`${c.id}: '${field}' e\' dichiarato letto ma NON e\' nel fixture ${c.fixture}`);
        if (!namesField(src, field)) problems.push(`${c.id}: '${field}' e\' dichiarato letto da ${file}, che non lo nomina`);
      }
    }
    for (const field of c.producedUnread) {
      if (!keys.has(field)) problems.push(`${c.id}: '${field}' e\' dichiarato prodotto-non-letto ma manca dal fixture`);
      for (const { file } of c.readBy) {
        if (namesField(read(file), field)) {
          problems.push(
            `${c.id}: '${field}' e\' dichiarato NON letto, ma ${file} lo nomina — ` +
              'se ora lo legge, toglilo da producedUnread e mettilo in readBy',
          );
        }
      }
    }
  }
  assert.deepEqual(
    problems,
    [],
    'Registro, fixture e consumatori non dicono piu\' la stessa cosa.\n' +
      'E\' il triangolo che rende il fixture una registrazione VERIFICATA invece di un\n' +
      `blob copiato una volta:\n  ${problems.join('\n  ')}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. La forma registrata passa, in tutti
// ─────────────────────────────────────────────────────────────────────────────

for (const c of REWIRE_CONTRACTS) {
  test(`[${c.id}] la forma registrata e' accettata da ${path.basename(c.consumer.refresh)}`, async () => {
    const { status, out } = await runRefresh(c, asBody(servable(c)));
    assert.equal(status, 0, why(c, `Il fixture registrato viene RIFIUTATO dal suo stesso consumatore:\n${out}`));
  });

  test(`[${c.id}] un 200 che non e' JSON non viene mai cachato`, async () => {
    // La forma piu' comune di rottura di una pubblicazione statica: una pagina
    // di errore servita con 200. Nessuno puo' permettersi di scriverla
    // sopra una copia buona.
    const { status, out } = await runRefresh(c, '<!doctype html><title>502</title>', { contentType: 'text/html' });
    assert.notEqual(status, 0, why(c, `Una pagina HTML servita con 200 e' stata accettata:\n${out}`));
    assert.match(out, c.notJsonExpect, why(c, `Rifiutata, ma con un messaggio inatteso:\n${out}`));
  });

  test(`[${c.id}] il ramo di scrittura mette in cache esattamente cio' che ha validato`, async () => {
    const payload = servable(c);
    const { status, out, root } = await runRefresh(c, asBody(payload), { check: false });
    assert.equal(status, 0, why(c, `Scrittura fallita:\n${out}`));
    const cache = path.join(root, c.consumer.cache);
    assert.ok(fs.existsSync(cache), why(c, `Uscito 0 senza scrivere ${c.consumer.cache}`));
    if (c.consumer.view) {
      // La cache e' una VISTA derivata da piu' artefatti: non puo' essere il
      // documento scaricato. Si controlla che questo input ci sia entrato.
      const view = JSON.parse(fs.readFileSync(cache, 'utf8'));
      assert.equal(view.sources?.[c.consumer.inputKey]?.reachable, true, why(c, `La vista non registra l'input '${c.consumer.inputKey}' come letto:\n${out}`));
      assert.ok(
        Object.values(view.cantons ?? {}).some((x) => x.blocks?.[c.consumer.inputKey]?.available),
        why(c, `Nessun cantone ha il blocco '${c.consumer.inputKey}' disponibile dalla registrazione:\n${out}`),
      );
      return;
    }
    assert.deepEqual(
      JSON.parse(fs.readFileSync(cache, 'utf8')),
      payload,
      why(c, 'La cache scritta non e\' il documento validato: qualcosa lo sta trasformando per strada.'),
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Le deformazioni che contano, contratto per contratto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `[nome, corpo, regex attesa]`. Ogni caso e' una cosa che il produttore
 * potrebbe cambiare e che, non rifiutata, non produrrebbe un errore ma un
 * articolo sbagliato.
 */
const MUTATIONS = {
  'border-wait-window': (c) => [
    [
      'windowDays diverso da 7',
      mutated(c, (p) => { p.windowDays = 14; }),
      /windowDays is 14, expected 7/,
      'La prosa dell\'articolo dice «settimana»: una finestra diversa produce numeri che contraddicono il testo.',
    ],
    [
      'weekEnd non ISO',
      mutated(c, (p) => { p.current.weekEnd = '09-08-2026'; }),
      /weekEnd is .*not an ISO date/,
      '`rangeLabel` finisce stampato nel corpo, e il gate di staleness si calcola su questa data.',
    ],
    [
      'weightedAvgMinutes come stringa',
      mutated(c, (p) => { p.current.perCrossing['chiasso-brogeda'].weightedAvgMinutes = '9.35'; }),
      /weightedAvgMinutes is not a finite number/,
      'Il ranking ordina su questo numero: una stringa lo ordinerebbe lessicograficamente.',
    ],
    [
      'totalSamples frazionario',
      mutated(c, (p) => { p.current.perCrossing['chiasso-brogeda'].totalSamples = 58.5; }),
      /totalSamples is not a non-negative integer/,
      'E\' un CONTEGGIO, e MIN_SAMPLES_FOR_RANKING=20 ci decide sopra chi entra in classifica.',
    ],
    [
      'finestra `previous` assente',
      mutated(c, (p) => { delete p.previous; }),
      /'previous' window missing/,
      'Senza la finestra precedente l\'articolo perde la sezione di trend SENZA fallire.',
    ],
    [
      'perCrossing come array',
      mutated(c, (p) => { p.current.perCrossing = []; }),
      /perCrossing is not an object/,
      'Un array passerebbe `typeof === object` e darebbe zero valichi.',
    ],
    [
      'finestra corrente vuota',
      mutated(c, (p) => { p.current.perCrossing = {}; }),
      /zero crossings/,
      'Zero valichi = articolo senza classifica.',
    ],
    [
      'finestra vecchia di oltre 14 giorni',
      mutated(c, (p) => {
        p.current.weekStart = '2026-01-01';
        p.current.weekEnd = '2026-01-07';
      }),
      /days ago — refusing to build a ranking article from stale data/,
      'Il publisher fermo e\' il fallimento che sembra un successo: numeri del mese scorso, articolo di questa settimana.',
    ],
    [
      'canton col codice del semicantone',
      mutated(c, (p) => { p.current.perCrossing['anieres'].canton = 'BS'; }),
      /canton is the half-canton BS, not its URL group/,
      'Le classifiche per cantone usano il codice del GRUPPO URL (BASILEA): BS non entrerebbe in nessuna.',
    ],
    [
      'canton come nome invece che codice',
      mutated(c, (p) => { p.current.perCrossing['anieres'].canton = 'Ginevra'; }),
      /canton is "Ginevra", not a canton URL group code/,
      'Un nome localizzato non combacia con nessun --canton: il valico sparirebbe dalla sua classifica.',
    ],
    [
      'canton di due lettere fuori dai 24 gruppi',
      mutated(c, (p) => { p.current.perCrossing['anieres'].canton = 'CH'; }),
      /canton is "CH", not a canton URL group code/,
      'Un codice sconosciuto esce dal filtro per cantone: la classifica uscirebbe troncata senza errore.',
    ],
  ],
  'border-wait-averages': (c) => [
    [
      'documento non mappa (array)',
      asBody(Object.values(readFixture(c))),
      /is not a crossing-slug map/,
      'Le chiavi SONO gli slug: senza, l\'overlay non si aggancia a nessun valico.',
    ],
    [
      'mappa vuota',
      asBody({}),
      /carries zero crossings/,
      'Zero valichi caching-ati sopra una copia buona spegnerebbero l\'overlay in silenzio.',
    ],
    [
      'valore numerico grezzo',
      mutated(c, (p) => { p['chiasso-brogeda'].morning = 15; }),
      /not a "N min" or "N-M min" range/,
      'Le stringhe finiscono VERBATIM nel corpo dell\'articolo: un numero nudo ci arriverebbe cosi\'.',
    ],
    [
      'stringa localizzata invece del formato pubblicato',
      mutated(c, (p) => { p['chiasso-brogeda'].morning = '4-15 minuti'; }),
      /not a "N min" or "N-M min" range/,
      'Il rendering e\' gia\' fatto dal produttore: se cambia lingua o unita\', cambia l\'articolo.',
    ],
    [
      'voce che non e\' un oggetto',
      mutated(c, (p) => { p['chiasso-brogeda'] = '4-15 min'; }),
      /is not an object/,
      'Un appiattimento della forma per-valico passerebbe come stringa e romperebbe l\'assegnazione a valle.',
    ],
  ],
  'fuel-cantons': (c) => [
    [
      'records[] assente',
      mutated(c, (p) => { delete p.records; }),
      /has no records\[\] array/,
      'Senza record il blocco dati dell\'hub sparirebbe sovrascrivendo una cache buona.',
    ],
    [
      'records[] vuoto',
      mutated(c, (p) => { p.records = []; }),
      /carries zero records/,
      'Un dataset vuoto caching-ato sopra uno buono spegne il blocco in silenzio.',
    ],
    [
      'schemaVersion diverso',
      mutated(c, (p) => { p.schemaVersion = 2; }),
      /expected 1 — refusing an unrecognised shape/,
      'E\' l\'unico segnale di versione: una forma nuova va letta consapevolmente, non indovinata.',
    ],
    [
      'generatedAt vecchio di oltre 7 giorni',
      mutated(c, (p) => { p.generatedAt = new Date(Date.now() - 10 * 86_400_000).toISOString(); }),
      /days ago — refusing stale data/,
      'Il producer gira ogni giorno: un dataset fermo stampa prezzi della settimana scorsa come di oggi.',
    ],
    [
      'prezzo in millesimi',
      mutated(c, (p) => { p.records[0].avg = 1995; }),
      /\.avg 1995 is not a per-litre price/,
      'Un cambio di unita\' passerebbe come numero e finirebbe stampato nel confronto CH/estero.',
    ],
    [
      'lato CH in euro',
      mutated(c, (p) => { p.records.find((r) => r.side === 'CH').currency = 'EUR'; }),
      /side CH priced in EUR/,
      'Il confronto CH/estero converte in base alla valuta: una valuta scambiata inverte il verdetto.',
    ],
    [
      'min sopra la media',
      mutated(c, (p) => { p.records[0].min = p.records[0].avg + 0.1; }),
      /is above avg/,
      'Un minimo sopra la media e\' un campo scambiato dal producer.',
    ],
    [
      'cantone fuori dai 24 gruppi',
      mutated(c, (p) => { p.records[0].canton = 'BS'; }),
      /is not one of the 24 groups/,
      'Gli hub sono per gruppo URL (BL/BS -> BASILEA): un codice reale non si aggancerebbe a nessun hub.',
    ],
    [
      'generatedAt nel futuro',
      mutated(c, (p) => { p.generatedAt = new Date(Date.now() + 3 * 86_400_000).toISOString(); }),
      /is in the future — refusing/,
      'Un\'eta\' negativa passerebbe il gate dei 7 giorni per sempre: un timestamp sbagliato terrebbe verde il watcher.',
    ],
    [
      'cantons con un gruppo ripetuto 24 volte',
      mutated(c, (p) => { p.cantons = Array(24).fill('TI'); }),
      /is not the list of the 24 canton URL groups/,
      'La sola lunghezza autorizzerebbe un dataset che ha perso gli altri 23 gruppi.',
    ],
    [
      'cantons con un codice reale al posto del gruppo',
      mutated(c, (p) => { p.cantons = p.cantons.map((x) => (x === 'BASILEA' ? 'BS' : x)); }),
      /is not the list of the 24 canton URL groups/,
      'La lista deve essere quella canonica di canton-url-slugs.json, non 24 stringhe qualsiasi.',
    ],
    [
      'record duplicato per (canton, side, fuel)',
      mutated(c, (p) => { p.records.push({ ...p.records[0], avg: p.records[0].avg + 0.01 }); }),
      /duplicate record for/,
      'Due righe confliggenti lascerebbero all\'hub la scelta di quale prezzo stampare.',
    ],
    [
      'observedAt numerico',
      mutated(c, (p) => { p.records[0].observedAt = Date.now(); }),
      /observedAt .* is not an ISO instant/,
      'Un epoch o una data senza fuso verrebbe formattato nel fuso del runner.',
    ],
    [
      'granularita sconosciuta',
      mutated(c, (p) => { p.records[0].granularity = 'regional'; }),
      /granularity .* is not station\|region\|national/,
      'Il renderer deve distinguere una stazione da una media regionale o nazionale, senza inferirlo dal conteggio.',
    ],
    [
      'granularita nulla esplicita',
      mutated(c, (p) => { p.records[0].granularity = null; }),
      /granularity null is not station\|region\|national/,
      'Solo l\'assenza del campo è legacy: null esplicito non descrive una granularità pubblicabile.',
    ],
    [
      'lato sconosciuto',
      mutated(c, (p) => { p.records[0].side = 'LI'; }),
      /is not CH\|FR\|AT\|IT\|DE/,
      'Il blocco dati conosce cinque lati: un sesto verrebbe ignorato o mal etichettato.',
    ],
    [
      'health DE non dichiarata',
      mutated(c, (p) => { p.health.de = 'error'; }),
      /health\.de .* is not ok\|skipped\|failed:<reason>/,
      'La salute della fonte DE deve distinguere un overlay saltato da uno fallito, senza diventare un gate sui record CH.',
    ],
  ],
  'road-events': (c) => [
    [
      'events[] vuoto',
      mutated(c, (p) => { p.events = []; }),
      /carries zero events/,
      'Zero eventi in cache = hub mobilita\' vuoti per tutti i cantoni.',
    ],
    [
      'schemaVersion diverso',
      mutated(c, (p) => { p.schemaVersion = 2; }),
      /schemaVersion is 2, expected 1/,
      'Una forma nuova non va interpretata con le regole della vecchia.',
    ],
    [
      'canton col codice del semicantone',
      mutated(c, (p) => { p.events[0].canton = 'BL'; }),
      /half-canton BL, not its URL group/,
      'Gli hub sono per gruppo URL (BASILEA, APPENZELLO): BL non ne raggiungerebbe nessuno.',
    ],
    [
      'canton di due lettere fuori dai 24 gruppi',
      mutated(c, (p) => { p.events[0].canton = 'XX'; }),
      /canton "XX" is not one of the 24 canton URL groups/,
      'Un codice sconosciuto non si aggancia a nessun hub: l\'evento sparirebbe in silenzio.',
    ],
    [
      'generatedAt nel futuro',
      mutated(c, (p) => { p.generatedAt = new Date(Date.now() + 72 * 3_600_000).toISOString(); }),
      /is in the future/,
      'Un orologio sbagliato del producer passerebbe il gate di eta\' per sempre.',
    ],
    [
      'data locale invece di ISO',
      mutated(c, (p) => { p.events[0].observedAt = 'Mon, 05 Oct 2026 10:00:00 GMT'; }),
      /observedAt is not an ISO date/,
      'Il contratto dichiara istanti ISO: una data locale accettata da Date.parse passerebbe ambigua.',
    ],
    [
      'id duplicato',
      mutated(c, (p) => { p.events[1].id = p.events[0].id; }),
      /is duplicated/,
      'Due eventi con lo stesso id collasserebbero in uno a valle.',
    ],
    [
      'validFrom dopo validTo',
      mutated(c, (p) => {
        const e = p.events.find((x) => x.validFrom && x.validTo);
        [e.validFrom, e.validTo] = [e.validTo, e.validFrom];
      }),
      /validFrom is after validTo/,
      'Una finestra rovesciata non e\' mai attiva: l\'evento sarebbe mostrato o nascosto a caso.',
    ],
    [
      'tipo fuori dai quattro',
      mutated(c, (p) => { p.events[0].type = 'incidente'; }),
      /type "incidente" is not one of/,
      'Il tipo decide in quale blocco dell\'hub finisce l\'evento.',
    ],
    [
      'url non https',
      mutated(c, (p) => { p.events.find((e) => e.url).url = 'http://example.org/x'; }),
      /url is not https or null/,
      'Un link stampato in un articolo deve essere https.',
    ],
    [
      'snapshot vecchio di giorni',
      mutated(c, (p) => { p.generatedAt = '2026-01-01T00:00:00.000Z'; }),
      /refusing stale road events/,
      'Il collector fermo e\' il fallimento che sembra un successo: chiusure gia\' riaperte date per attive.',
    ],
  ],
  'events-dataset': (c) => [
    [
      'events[] assente',
      mutated(c, (p) => { delete p.events; }),
      /has no events\[\] array/,
      '`loadEventsDataset()` inghiotte tutto e ritorna zero eventi: il digest renderizza un weekend vuoto.',
    ],
    [
      'events[] vuoto',
      mutated(c, (p) => { p.events = []; }),
      /carries zero public events — refusing to cache an empty dataset/,
      'Zero eventi SOVRASCRIVE il digest corretto sulla URL evergreen.',
    ],
    [
      'schemaVersion non numerico',
      mutated(c, (p) => { p.schemaVersion = '1'; }),
      /has no numeric schemaVersion/,
      'E\' l\'unico segnale di versione che il contratto ha.',
    ],
    [
      'nessun evento con startDate',
      mutated(c, (p) => { for (const e of p.events) delete e.startDate; }),
      /not one public event carries a startDate — refusing/,
      'Tutta la selezione del weekend passa da startDate: senza, ogni evento e\' fuori finestra.',
    ],
  ],
  'canton-notices': (c) => [
    ['notices[] assente', mutated(c, (p) => { delete p.notices; }), /has no notices\[\] array/, 'Senza la lista gli hub non hanno avvisi da mostrare.'],
    [
      'dataset troncato sotto il minimo',
      mutated(c, (p) => { p.notices = p.notices.slice(0, 10); }),
      /carries 10 notices/,
      'Un publish parziale sembrerebbe un elenco valido con pochi avvisi.',
    ],
    [
      'canton che non e\' un gruppo URL',
      mutated(c, (p) => { p.notices[0].canton = 'BS'; }),
      /is not a URL group/,
      'BS e BL stanno nel gruppo BASILEA: un codice reale al posto del gruppo non trova nessun hub.',
    ],
    [
      'categoria fuori dagli hub',
      mutated(c, (p) => { p.notices[0].category = 'cronaca'; }),
      /is not a hub category/,
      'Una categoria nuova finirebbe in un blocco che non esiste.',
    ],
    [
      'publishedAt in formato locale',
      mutated(c, (p) => { p.notices[0].publishedAt = '02.10.2026'; }),
      /neither null nor an ISO date/,
      'L\'ordinamento per data e\' lessicografico su ISO: dd.mm.yyyy lo romperebbe.',
    ],
    [
      'crawler fermo da giorni',
      mutated(c, (p) => { p.generatedAt = new Date(Date.now() - 10 * 86_400_000).toISOString(); }),
      /days old/,
      'Il produttore fermo e\' il fallimento che sembra un successo: avvisi vecchi presentati come attuali.',
    ],
    [
      'id duplicato',
      mutated(c, (p) => { p.notices[1].id = p.notices[0].id; }),
      /duplicate id/,
      'L\'id e\' la chiave di dedup degli hub: due voci con lo stesso id ne nascondono una.',
    ],
  ],
  'health-premiums': (c) => [
    ['quotes{} assente', mutated(c, (p) => { delete p.quotes; }), /quotes\{\} missing/, 'Senza quotes non c\'e\' nessun premio da riassumere.'],
    ['year non intero', mutated(c, (p) => { p.year = String(p.year); }), /year is not an integer/, 'L\'anno decide se i premi sono quelli in vigore.'],
  ],
  'plate-auctions': (c) => [
    ['schema cambiato', mutated(c, (p) => { p.schema = 2; }), /schema is 2/, 'Uno schema nuovo va letto apposta, non indovinato.'],
    ['auctions[] assente', mutated(c, (p) => { delete p.auctions; }), /auctions\[\] missing/, 'Zero aste lette come «nessuna asta attiva».'],
  ],
  'pharmacy-duty-cantons': (c) => [
    ['schemaVersion cambiato', mutated(c, (p) => { p.schemaVersion = 2; }), /schemaVersion is 2/, 'Uno schema nuovo va letto apposta.'],
    [
      'duties non e\' una lista',
      mutated(c, (p) => { p.cantons.TI.duties = {}; }),
      /TI\.duties\[\] missing/,
      'I turni sono la sola cosa che il blocco mostra.',
    ],
  ],
  'weather-snapshot': (c) => [
    ['cities{} vuoto', mutated(c, (p) => { p.cities = {}; }), /cities\{\} missing or empty/, 'Zero citta\' = blocco meteo sparito senza errore.'],
    ['generatedAt non data', mutated(c, (p) => { p.generatedAt = 'oggi'; }), /generatedAt is not a date/, 'La freschezza del meteo si misura su questo campo.'],
  ],
  'canton-tax': (c) => [
    [
      'schemaVersion diverso',
      mutated(c, (p) => { p.schemaVersion = 2; }),
      /has schemaVersion 2, expected 1/,
      'Una forma nuova non dichiarata va letta da qualcuno prima di finire in un hub fiscale.',
    ],
    [
      'anno vecchio di due anni',
      mutated(c, (p) => freshenYear(p, CURRENT_YEAR - 2)),
      /is stale/,
      'Un publisher fermo consegnerebbe aliquote di due anni fa come attuali.',
    ],
    [
      'cantone mancante',
      mutated(c, (p) => { delete p.cantons.TI; }),
      /cantons missing: TI/,
      'Un hub cantonale senza il suo cantone non deve sovrascrivere quello buono.',
    ],
    [
      'curva dell\'onere troncata a quattro redditi',
      mutated(c, (p) => {
        p.burden.incomeBracketsCHF = p.burden.incomeBracketsCHF.slice(0, 4);
        for (const canton of Object.values(p.cantons)) canton.burdenPct[String(p.year)] = canton.burdenPct[String(p.year)].slice(0, 4);
      }),
      /incomeBracketsCHF is not a list of 5 incomes/,
      'Una curva coerente ma con meno punti passerebbe il controllo riga per riga: il contratto e\' di cinque redditi.',
    ],
    [
      'onere come stringhe',
      mutated(c, (p) => { p.cantons.ZH.burdenPct[String(p.year)] = p.cantons.ZH.burdenPct[String(p.year)].map(String); }),
      /ZH burdenPct \d{4} is not 5 percentages/,
      'Le percentuali finiscono in prosa: una stringa passerebbe e verrebbe confrontata male.',
    ],
    [
      'onere in frazioni invece che in percentuale',
      mutated(c, (p) => { p.cantons.GE.burdenPct[String(p.year)] = [0.0188, 0.0983, 0.1548, 0.2003, 0.2611]; }),
      /GE burdenPct \d{4} tops out at 0.2611%/,
      'Un cambio di unita\' (frazione al posto di %) produrrebbe un onere dello 0,2%.',
    ],
    [
      'tariffe alla fonte sotto soglia',
      mutated(c, (p) => { for (const code of ['AG', 'AI', 'AR']) p.cantons[code].withholding = null; }),
      /withholding A0 rates for only 23\/26 cantons/,
      'Sotto 24 cantoni il dataset non e\' quello che il produttore ha validato.',
    ],
  ],
  'pension-parameters': (c) => [
    [
      'schemaVersion diverso',
      mutated(c, (p) => { p.schemaVersion = 2; }),
      /has schemaVersion 2, expected 1/,
      'Una forma nuova non dichiarata va letta da qualcuno prima di finire in un hub pensioni.',
    ],
    [
      'anno vecchio di due anni',
      mutated(c, (p) => { p.year = CURRENT_YEAR - 2; }),
      /is stale/,
      'La rendita AVS cambia ogni due anni: un dataset fermo pubblicherebbe la cifra superata.',
    ],
    [
      'rendita massima non doppia della minima',
      mutated(c, (p) => { p.federal.avs.maxMonthlyCHF = 2450; }),
      /is not twice min/,
      'Art. 34 LAVS: una coppia incoerente e\' un parse sbagliato a monte, non una cifra da pubblicare.',
    ],
    [
      'soglia LPP non derivata dalla rendita massima',
      mutated(c, (p) => { p.federal.lpp.entryThresholdCHF = 22050; }),
      /is not 3\/4 of the annual maximum AVS pension/,
      'La soglia d\'entrata e\' 3/4 della rendita massima annua per legge: 22\'050 e\' la soglia 2024.',
    ],
    [
      'massimale 3a come stringa',
      mutated(c, (p) => { p.federal.pillar3a.maxWithLppCHF = "7'258"; }),
      /pillar3a maxima are not positive integers/,
      'Le cifre finiscono in prosa e nei confronti numerici: una stringa formattata non e\' un importo.',
    ],
    [
      'cassa di compensazione senza url',
      mutated(c, (p) => { p.cantons.TI.compensationFund.url = null; }),
      /compensationFund name\/url missing for TI/,
      'L\'hub pensioni cantonale rimanda alla cassa AVS: senza link non ha la sua informazione principale.',
    ],
  ],
};

test('ogni contratto ha i suoi casi di deformazione', () => {
  assert.deepEqual(REWIRE_CONTRACTS.map((c) => c.id).filter((id) => typeof MUTATIONS[id] !== 'function'), []);
});

for (const c of REWIRE_CONTRACTS) {
  for (const [name, body, expected, rationale] of MUTATIONS[c.id]?.(c) ?? []) {
    test(`[${c.id}] rifiuta: ${name}`, async () => {
      const { status, out } = await runRefresh(c, body);
      assert.notEqual(status, 0, why(c, `Deformazione ACCETTATA: ${name}.\n${rationale}\n\n${out}`));
      assert.match(out, expected, why(c, `Rifiutata, ma non per il motivo atteso (${name}):\n${out}`));
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Il ramo degenere che i due repo NON asseriscono allo stesso modo
// ─────────────────────────────────────────────────────────────────────────────

test('[border-wait-averages] "N min" senza trattino resta accettato', async () => {
  // Asimmetria misurata, non ipotetica: `formatRange()` sul sito collassa un
  // range degenere [p25,p75] sul valore singolo invece di stampare "2-2 min",
  // e il test del sito (tests/compute-border-wait-averages.test.ts) asserisce
  // `\b\d+-\d+ min\b`, che quel caso NON copre. Due repo, due asserzioni
  // diverse sullo stesso formato: se qualcuno stringesse la regex di qua
  // «per uniformarla», il primo valico con p25 == p75 farebbe fallire il
  // refresh in produzione.
  const c = contract('border-wait-averages');
  const body = mutated(c, (p) => { p['ponte-tresa'].morning = '2 min'; });
  const { status, out } = await runRefresh(c, body);
  assert.equal(status, 0, why(c, `Il ramo degenere "2 min" e' stato rifiutato:\n${out}`));
});

test('[fuel-cantons] la cache legacy senza granularita resta leggibile durante il passaggio HTTP', async () => {
  const c = contract('fuel-cantons');
  const body = mutated(c, (p) => {
    for (const record of p.records) delete record.granularity;
  });
  const { status, out } = await runRefresh(c, body);
  assert.equal(status, 0, why(c, `La cache schema 1 senza granularita e' stata rifiutata durante il passaggio HTTP:\n${out}`));
  assert.match(out, /--check: .* records over .* cantons/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cio' che il gate lato fetch, per costruzione, non puo' vedere
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estrae gli slug del literal `BORDER_WAIT_CROSSINGS` da `borderWaitData.ts`.
 *
 * Ha una funzione propria perche' la prima versione, inline, sbagliava
 * ENTRAMBI gli estremi della finestra e lo faceva in silenzio:
 *
 *  - **inizio**: `src.indexOf('BORDER_WAIT_CROSSINGS')` non trova la
 *    dichiarazione (riga 249) ma la prima *menzione*, che sta nel commento
 *    «Adding a new crossing» a riga 201 («5. Add the slug to
 *    BORDER_WAIT_CROSSINGS (below)»);
 *  - **fine**: l'array chiude con `] as const;`, non con `];`, quindi
 *    `indexOf('];')` scavallava di ~30 KB fino al primo `];` letterale del
 *    file — dentro `BORDER_WAIT_ROUTES`, 543 righe piu' sotto.
 *
 * Misurato: la finestra sbagliata estraeva **166** token invece di 134,
 * inghiottendo `TOP_5_CROSSINGS`, `BORDER_CROSSING_DISPLAY`,
 * `CROSSING_TO_REGION`, `CROSSING_TO_FUEL_ZONE`, `BORDER_WAIT_REGIONS` e
 * `BORDER_WAIT_LOCALES`. Un test che dice «ogni slug del fixture e' un valico
 * che il consumatore conosce» verificava quindi l'appartenenza a un insieme
 * molto piu' largo: uno slug tolto da `BORDER_WAIT_CROSSINGS` ma rimasto in
 * una qualunque mappa successiva restava «conosciuto», ed e' esattamente la
 * rottura muta che questa suite esiste per chiudere.
 *
 * NB: spostare solo la fine a `] as const` — la correzione piu' ovvia — NON
 * basta e anzi peggiora: con l'inizio ancora sul commento, il primo
 * `] as const` incontrato e' quello di `BORDER_WAIT_LOCALES` (riga 242), che
 * sta PRIMA dell'array. Si estrarrebbero 24 token (regioni, zone carburante e
 * i quattro codici locale) e i 10 slug del fixture diventerebbero tutti
 * sconosciuti: rosso falso. Vanno corretti tutti e due gli estremi.
 */
function extractBorderWaitCrossings(src) {
  // Ancorato alla DICHIARAZIONE, non al nome: `export const NOME ... = [`.
  const decl = /export\s+const\s+BORDER_WAIT_CROSSINGS\s*:[^=]*=\s*\[/.exec(src);
  assert.ok(
    decl,
    'dichiarazione di BORDER_WAIT_CROSSINGS non trovata in borderWaitData.ts: ' +
      'il literal ha cambiato forma e questa estrazione va riscritta (non allentata)',
  );
  const after = src.slice(decl.index + decl[0].length);
  const end = after.indexOf(']');
  assert.notEqual(end, -1, 'array BORDER_WAIT_CROSSINGS non chiuso: sorgente troncata?');
  const slugs = new Set([...after.slice(0, end).matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));

  // Non-vacuita' con un pavimento vero. Il file dichiara «Full crossing
  // registry (134)» sopra l'array; la soglia sta sotto quel numero per non
  // rompersi quando un valico viene aggiunto o tolto, ma abbastanza in alto
  // da non poter essere soddisfatta da nessuna delle due finestre sbagliate
  // sopra (166 la vecchia, 24 la correzione a meta').
  assert.ok(
    slugs.size >= 100,
    `estrazione di BORDER_WAIT_CROSSINGS fallita (${slugs.size} slug, attesi ~134): il literal e' cambiato forma`,
  );

  // Guardia di REGRESSIONE diretta sui due sconfinamenti. Questi token
  // esistono in borderWaitData.ts ma NON sono valichi: sono zone carburante
  // (`chiasso`), regioni (`ticino-como`, `basilea-germania`) e codici locale
  // (`it`). Se ricompaiono qui, la finestra e' di nuovo fuori posto — e' il
  // controllo che la versione precedente non aveva, ed e' il motivo per cui
  // il difetto e' passato con la suite verde.
  for (const token of ['it', 'en', 'de', 'fr', 'chiasso', 'mendrisio', 'lugano', 'ticino-como', 'basilea-germania']) {
    assert.ok(
      !slugs.has(token),
      `'${token}' non e' un valico ma e' finito nell'estrazione: la finestra su ` +
        'BORDER_WAIT_CROSSINGS ha di nuovo scavallato la fine dell\'array ' +
        '(era il difetto: indexOf(\'];\') saltava a BORDER_WAIT_ROUTES, 543 righe piu\' sotto)',
    );
  }
  return slugs;
}

test('[border-wait-window] il vocabolario degli slug e\' quello che il consumatore riconosce', () => {
  // `checkWindow()` conta `Object.keys(per).length` sul payload GREZZO, prima
  // di qualunque filtro: 141 valichi pubblicati, di cui la stragrande
  // maggioranza non ticinesi. Rinominare gli slug ticinesi lascia quel conteggio
  // altissimo, `--check` passa, e a valle non resta niente da classificare.
  // Il filtro vero (`isTicinoCrossing`) sta in un `.ts` e `node --test` non
  // importa TypeScript; cio' che si puo' inchiodare qui e' il vocabolario:
  // ogni slug del fixture deve essere un valico che il consumatore conosce.
  const c = contract('border-wait-window');
  const src = read('generator/build-plugins/borderWaitData.ts');
  const known = extractBorderWaitCrossings(src);

  const fixture = readFixture(c);
  const unknown = Object.keys(fixture.current.perCrossing).filter((slug) => !known.has(slug));
  assert.deepEqual(
    unknown,
    [],
    why(
      c,
      'Slug del fixture che BORDER_WAIT_CROSSINGS non conosce piu\':\n  ' +
        `${unknown.join('\n  ')}\n\n` +
        'Un valico che il consumatore non riconosce viene scartato DOPO il conteggio del\n' +
        'gate lato fetch: `--check` resta verde e la classifica si svuota.',
    ),
  );
});

test('[border-wait-window] la registrazione produce una classifica non degenere', () => {
  // `hasData = known.length >= 2` nel content builder: sotto due valichi
  // l'articolo diventa lo stub «non ci sono ancora abbastanza dati». Il
  // fixture deve restare sopra quella soglia, altrimenti la suite girerebbe
  // sopra un caso degenere credendo di coprire quello normale.
  const c = contract('border-wait-window');
  const fixture = readFixture(c);
  const ranking = rankingFromStats(fixture.current.perCrossing);
  assert.ok(
    ranking.length >= 2,
    why(c, `Solo ${ranking.length} valico/i sopra MIN_SAMPLES_FOR_RANKING=${MIN_SAMPLES_FOR_RANKING}: l'articolo sarebbe uno stub.`),
  );
  // Ordinamento crescente = «migliore» prima. Se il produttore passasse a
  // secondi o a una media non pesata i controlli di forma resterebbero tutti
  // verdi, quindi qui si tiene fermo almeno l'ORDINE DI GRANDEZZA: minuti di
  // attesa a una dogana, non secondi (che gonfierebbero di 60x) e non ore.
  for (const r of ranking) {
    assert.ok(
      r.avgMinutes >= 0 && r.avgMinutes < 240,
      why(c, `${r.slug}: ${r.avgMinutes} non e' un'attesa in MINUTI (0..240). Cambio di unita' sul produttore?`),
    );
  }
  assert.deepEqual(
    ranking.map((r) => r.rank),
    ranking.map((_, i) => i + 1),
    why(c, 'Il rank non e\' piu\' 1..N consecutivo.'),
  );
});

test('[border-wait-window] la soglia dei campioni scarta davvero, e in silenzio', () => {
  // La terza strada della issue #101: se il produttore cambiasse la SEMANTICA
  // di totalSamples (osservazione singola vs bucket orario) i valichi
  // entrerebbero o uscirebbero dalla classifica senza che niente diventi rosso.
  // Il fixture conserva tre valichi con `previous.totalSamples = 16` — sotto la
  // soglia di 20 — presi dalla registrazione vera: sono la prova che lo scarto
  // avviene e che nessuno lo segnala.
  const c = contract('border-wait-window');
  const fixture = readFixture(c);
  const belowInPrevious = Object.entries(fixture.previous.perCrossing)
    .filter(([, s]) => s.totalSamples < MIN_SAMPLES_FOR_RANKING)
    .map(([slug]) => slug);
  assert.ok(
    belowInPrevious.length > 0,
    'Il fixture ha perso i valichi sotto soglia: senza, questo test non prova piu\' niente.',
  );
  const trend = trendFromStats(fixture.current.perCrossing, fixture.previous.perCrossing);
  for (const slug of belowInPrevious) {
    assert.equal(
      trend[slug],
      undefined,
      why(c, `${slug} ha ${fixture.previous.perCrossing[slug].totalSamples} campioni nella finestra precedente e compare comunque nel trend.`),
    );
  }
  assert.ok(Object.keys(trend).length > 0, why(c, 'Nessun valico ha un trend: la sezione settimanale sarebbe vuota.'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Chi scarica davvero la cache che i consumatori leggono
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Workflow → invocazioni del `refresh` di un contratto che SCRIVONO la cache
 * (niente `--check`, niente `DRY_RUN`), per path diretto o per script npm.
 * Le righe di commento non contano.
 */
function fetchingWorkflows(c) {
  const scripts = JSON.parse(read('package.json')).scripts ?? {};
  const npmNames = Object.entries(scripts)
    .filter(([, cmd]) => String(cmd).includes(c.consumer.refresh))
    .map(([name]) => name);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(escape(c.consumer.refresh)),
    ...npmNames.map((n) => new RegExp(`npm run ${escape(n)}(?![\\w:-])`)),
  ];
  const dir = path.join(ROOT, '.github/workflows');
  const found = new Set();
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (/^\s*#/.test(line)) continue;
      if (!patterns.some((re) => re.test(line))) continue;
      if (/--check\b|DRY_RUN=(1|true)/.test(line)) continue;
      // Un path nominato fuori da un comando (filtri `paths:` dei trigger) non scarica niente.
      if (/^\s*-\s*['"]?generator\//.test(line)) continue;
      found.add(file);
    }
  }
  return [...found].sort();
}

for (const c of REWIRE_CONTRACTS) {
  test(`[${c.id}] chi scarica la cache e' dichiarato, in entrambe le direzioni`, () => {
    const pf = c.productionFetch;
    assert.ok(pf && (Array.isArray(pf.workflows) || typeof pf.none === 'string'), why(c,
      '`productionFetch` manca: dichiara i workflow che scaricano l\'artefatto (`workflows`, `ci`) ' +
        'oppure `none` con il motivo. Un consumatore che legge una cache che nessuno riempie e\' ' +
        'esattamente il buco di `border-wait-averages`.'));
    const declared = pf.none !== undefined ? [] : [...pf.workflows, ...(pf.ci ?? [])].sort();
    if (pf.none !== undefined) assert.ok(pf.none.trim().length > 40, why(c, '`none` senza un motivo scritto'));
    assert.deepEqual(fetchingWorkflows(c), declared, why(c,
      'I workflow che eseguono il refresh SENZA --check non sono quelli dichiarati in ' +
        '`productionFetch`. Se hai cablato (o tolto) il download in un workflow, aggiorna la ' +
        'dichiarazione nello stesso commit; se e\' sparito per errore, i lettori della cache in ' +
        'produzione stanno leggendo una cache vuota.'));
  });
}
