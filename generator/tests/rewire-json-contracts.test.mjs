/**
 * rewire-json-contracts.test.mjs — i tre contratti JSON del REWIRE set,
 * inchiodati dal lato del CONSUMATORE (issue #101).
 *
 * ## Il buco che chiude
 *
 * Il sito pubblica tre artefatti su `cdn.frontaliereticino.ch/data/` e questo
 * repo li consuma. I due capi hanno nomi diversi e non si importano, quindi il
 * legame non e' visto da nessuno dei guard esistenti — ne' dal drift check (che
 * confronta per path), ne' dai closure test (che seguono gli import), ne' da
 * `loop-references-exist.test.mjs` (che verifica che un path citato ESISTA: la
 * sua esistenza non dice niente sulla sua forma). Il razionale completo, e le
 * tre coppie, stanno in `generator/tests/lib/rewire-contracts.mjs`.
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
 * I tre `refresh` risolvono la propria cache da `import.meta.url`, non da `cwd`:
 * eseguirli in loco leggerebbe (e, senza `--check`, scriverebbe) le cache vere
 * del repo. Su `refresh-border-wait-averages.mjs` non e' teorico — la guardia
 * anti-shrink confronta col file di cache ESISTENTE, quindi su una macchina che
 * ha gia' fatto un refresh vero il fixture da 10 valichi verrebbe rifiutato per
 * un motivo che col contratto non c'entra. Copiare lo script alla stessa
 * profondita' relativa dentro una temp dir rende la suite ermetica e permette di
 * esercitare anche il ramo di SCRITTURA, che e' quello che produce il file che
 * `borderCrossings.ts` legge davvero.
 *
 * La copia e' fedele solo finche' i tre script importano esclusivamente builtin
 * Node: c'e' un test qui sotto che lo tiene fermo, perche' il giorno in cui uno
 * di loro importasse un modulo locale l'armatura smetterebbe di testare il file
 * vero senza dirlo a nessuno.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REWIRE_CONTRACTS, contract, freshenWindow } from './lib/rewire-contracts.mjs';
import { rankingFromStats, trendFromStats, MIN_SAMPLES_FOR_RANKING } from '../scripts/lib/border-wait-ranking.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readFixture = (c) => JSON.parse(read(c.fixture));

/** Oggi, come lo vedono i gate temporali dei `refresh`. */
const TODAY = new Date().toISOString().slice(0, 10);

/**
 * Il payload registrato, rimesso in data quando il contratto lo richiede.
 * Solo il border-wait window ha un gate di staleness; gli altri due no.
 */
function servable(c) {
  const payload = readFixture(c);
  return c.id === 'border-wait-window' ? freshenWindow(payload, TODAY) : payload;
}

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
 * Esegue il `refresh` di un contratto contro un corpo servito in locale.
 * Ritorna `{ status, out, root }` — `root` e' la temp dir, cosi' il chiamante
 * puo' ispezionare la cache scritta.
 */
async function runRefresh(c, body, { check = true } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), `rewire-${c.id}-`));
  const script = path.join(root, c.consumer.refresh);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(path.join(ROOT, c.consumer.refresh), script);

  const served = await serve(body);
  try {
    // `spawn` e non `spawnSync`: il server sta in QUESTO processo, e una spawn
    // sincrona blocca l'event loop — la richiesta del figlio non verrebbe mai
    // servita e ogni caso finirebbe in timeout. Costa mezz'ora di diagnosi
    // trovarlo, perche' il sintomo e' «i test sono lenti», non «sbagliati».
    const res = await new Promise((resolve) => {
      const child = spawn(process.execPath, check ? [script, '--check'] : [script], {
        env: { ...process.env, [c.consumer.envUrl]: served.url },
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
  }
}

const asBody = (payload) => JSON.stringify(payload);

/** Copia profonda del payload servibile, per mutarlo senza toccare il fixture. */
const mutated = (c, fn) => {
  const payload = structuredClone(servable(c));
  const out = fn(payload);
  return asBody(out === undefined ? payload : out);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Il registro non deve poter marcire
// ─────────────────────────────────────────────────────────────────────────────

test('ogni contratto dichiarato ha i suoi file: refresh, fixture, consumatori', () => {
  assert.equal(REWIRE_CONTRACTS.length, 3, 'il REWIRE set e\' di tre artefatti (issue #101)');
  const missing = [];
  for (const c of REWIRE_CONTRACTS) {
    for (const rel of [c.consumer.refresh, c.fixture, ...c.readBy.map((r) => r.file)]) {
      if (!fs.existsSync(path.join(ROOT, rel))) missing.push(`${c.id}: ${rel}`);
    }
  }
  assert.deepEqual(missing, [], `File dichiarati nel registro REWIRE e assenti:\n  ${missing.join('\n  ')}`);
});

test('i tre refresh importano SOLO builtin Node — altrimenti la copia in temp dir mente', () => {
  const offenders = [];
  for (const c of REWIRE_CONTRACTS) {
    const src = read(c.consumer.refresh);
    for (const m of src.matchAll(/^\s*import\s[^\n]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (!m[1].startsWith('node:')) offenders.push(`${c.consumer.refresh} → ${m[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Un `refresh` ha smesso di essere autoconsistente.\n' +
      'Questa suite lo COPIA in una temp dir per isolarne la cache: con un import\n' +
      'relativo la copia non risolve piu\', e il test o esplode o — peggio — smette di\n' +
      'esercitare il file vero. Se l\'import serve, l\'armatura va cambiata insieme:\n' +
      `  ${offenders.join('\n  ')}`,
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
// 2. La forma registrata passa, in tutti e tre
// ─────────────────────────────────────────────────────────────────────────────

for (const c of REWIRE_CONTRACTS) {
  test(`[${c.id}] la forma registrata e' accettata da ${path.basename(c.consumer.refresh)}`, async () => {
    const { status, out } = await runRefresh(c, asBody(servable(c)));
    assert.equal(status, 0, why(c, `Il fixture registrato viene RIFIUTATO dal suo stesso consumatore:\n${out}`));
  });

  test(`[${c.id}] un 200 che non e' JSON non viene mai cachato`, async () => {
    // La forma piu' comune di rottura di una pubblicazione statica: una pagina
    // di errore servita con 200. Nessuno dei tre puo' permettersi di scriverla
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
      /carries zero events/,
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
      /not one event carries a startDate/,
      'Tutta la selezione del weekend passa da startDate: senza, ogni evento e\' fuori finestra.',
    ],
  ],
};

for (const c of REWIRE_CONTRACTS) {
  for (const [name, body, expected, rationale] of MUTATIONS[c.id](c)) {
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
