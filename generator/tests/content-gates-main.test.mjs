/**
 * content-gates-main.test.mjs — il CABLAGGIO del gate sul contenuto di `main`.
 *
 * ## Perché un test sullo YAML e non solo sullo script
 *
 * Il difetto che questo gate chiude viveva interamente nel blocco di testa di un
 * workflow: `push: branches-ignore: [main]`. `on:` e `concurrency:` non si
 * eseguono mai — li interpreta GitHub, una volta sola, prima che qualunque step
 * esista — quindi un difetto lì non produce un errore, produce un'ASSENZA. È la
 * stessa ragione per cui esiste `loop-workflow-triggers.test.mjs`, e la stessa
 * ragione per cui la #267 è potuta restare aperta per giorni senza che nulla
 * diventasse rosso: nessun log mostra una run che non è partita.
 *
 * Le asserzioni qui sotto costano microsecondi e coprono le quattro forme in cui
 * questo gate può tornare inerte:
 *
 *   1. il trigger smette di guardare `main` o `content/**` → non parte più;
 *   2. la lista dei gate si svuota → parte e non guarda niente;
 *   3. il preflight anti-falso-verde viene allentato → passa su zero file;
 *   4. il titolo dell'alert perde il discriminante nel taglio a 60 caratteri →
 *      dedupplica sulla issue sbagliata.
 *
 * Più una quinta, che non è di questo file ma di cui questo file è l'unico
 * osservatore: che `tests.yml` continui a produrre un verdetto su `main`, perché
 * `mainTestsRuns()` lo legge per NOME e senza quel verdetto il rescue `stuck-red`
 * di `pr-autorebase` resta spento (misurato: `total_count = 0` su 849 run).
 *
 * corpus-only: sul sito non esiste un gemello: il sito non genera il corpus.
 *
 * Run with `node --test generator/tests/content-gates-main.test.mjs`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTENT_GATES,
  NON_SONO_CONTENT_GATES,
  REQUIRED_FILES,
  detectCorpusReaders,
  TITLE,
  buildIssueBody,
  extractOffenders,
  parseTapFailures,
  preflight,
} from '../../scripts/ci/content-gates-main.mjs';
import { VITEST_CHECK_NAME } from '../../scripts/ci/lib/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Solo le righe eseguibili: i commenti di questi workflow CITANO il difetto per
 * intero (`branches-ignore: [main]` compare più volte in prosa) e un match sul
 * testo grezzo lo leggerebbe come ancora presente. */
const active = (src) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

const WF_REL = '.github/workflows/content-gates-main.yml';
const WF = active(read(WF_REL));
const TESTS_WF = active(read('.github/workflows/tests.yml'));

describe('content-gates-main: il workflow', () => {
  test('esiste ed è cablato su push a main limitato a content/**', () => {
    assert.ok(fs.existsSync(path.join(ROOT, WF_REL)), `${WF_REL} non esiste`);
    const onBlock = WF.slice(WF.indexOf('\non:'), WF.indexOf('\npermissions:'));
    assert.match(
      onBlock,
      /push:\s*\n\s+branches: \[main\]/,
      'Il trigger non è `push: branches: [main]`. È esattamente il ramo che manca a ' +
        '`tests.yml`: senza, il contenuto generato dai bot resta senza gate — e la rottura ' +
        'ricompare come un rosso su PR estranee, ore dopo.',
    );
    assert.match(
      onBlock,
      /paths:\s*\n\s+- 'content\/\*\*'/,
      "Il filtro sui path è sparito: il gate girerebbe su OGNI push a main (~180 al giorno " +
        'dai bot) per guardare un corpus che non è cambiato.',
    );
    assert.match(
      onBlock,
      /workflow_dispatch:/,
      'Senza `workflow_dispatch` non c\'è modo di rilanciare il gate dopo una riparazione a ' +
        'mano del corpus: si aspetterebbe il prossimo articolo generato.',
    );
  });

  test('la concurrency collassa i ~90 push al giorno in poche run', () => {
    const m = WF.match(/\nconcurrency:\n\s+group:\s*(.+)\n\s+cancel-in-progress:\s*(.+)/);
    assert.ok(m, 'blocco `concurrency:` di primo livello non trovato');
    assert.ok(
      !m[1].includes('${{'),
      `Il group interpola qualcosa (${m[1]}): su main il ref è sempre lo stesso, quindi un ` +
        'group per-ref non collassa niente e costa solo un nome più lungo.',
    );
    assert.equal(
      m[2].trim(),
      'true',
      'Senza `cancel-in-progress: true` i push dei bot fanno CODA invece di collassare. Qui ' +
        'conta solo l\'ULTIMO stato di `main`, e una run cancellata non lascia niente di ' +
        'sporco: lo script non scrive sul repo.',
    );
  });

  test('NON è un required check e non entra nel gate dell\'auto-merge', () => {
    assert.ok(
      !/\n\s*pull_request:/.test(WF),
      'Un trigger `pull_request` renderebbe questo workflow un check-run sulle PR, cioè ' +
        'candidato a required check — e questo gate deve poter essere rosso senza fermare ' +
        'nessun merge.',
    );
    const jobName = (WF.match(/\n\s+name: (.+)\n\s+runs-on:/) || [])[1];
    assert.ok(jobName, 'nessun `name:` sul job');
    assert.notEqual(
      jobName.trim(),
      VITEST_CHECK_NAME,
      `Il job si chiama come CI_CHECK_NAME (${VITEST_CHECK_NAME}): l'auto-merge legge il ` +
        'check-run per NOME, e una run su main con quel nome entrerebbe in un grafo che non è ' +
        'il suo.',
    );
  });

  test('apre le issue col PAT, non col GITHUB_TOKEN', () => {
    assert.match(
      WF,
      /GH_TOKEN: \$\{\{ env\.GITHUB_PAT_NANAKO \|\| secrets\.GITHUB_TOKEN \}\}/,
      "Una issue creata dal GITHUB_TOKEN non emette `issues: opened` (anti-ricorsione " +
        'GitHub): nascerebbe fuori dal triage event-driven e nessuno la instraderebbe al fixer.',
    );
    assert.match(WF, /issues: write/, 'senza `issues: write` lo script non può aprire niente');
  });
});

describe('content-gates-main: la lista dei gate', () => {
  test('non è vuota e ogni gate elencato esiste davvero', () => {
    assert.ok(
      CONTENT_GATES.length >= 10,
      `Solo ${CONTENT_GATES.length} gate. La lista è MISURATA (i file di ` +
        '`generator/tests/` che leggono `content/` sotto un hook su fs): se si è accorciata, ' +
        'o il metodo è cambiato o qualcuno ha tolto copertura senza dirlo.',
    );
    const ghosts = CONTENT_GATES.filter((g) => !fs.existsSync(path.join(ROOT, g)));
    assert.deepEqual(
      ghosts,
      [],
      `gate elencati che non esistono:\n  ${ghosts.join('\n  ')}\n` +
        "`node --test` su un path inesistente non è un errore rumoroso: la run resta verde con " +
        'un gate in meno.',
    );
  });

  test('contiene i tre gate che il difetto ha prodotto dal vivo', () => {
    // 2026-08-18: le sei PR aperte (#410, #413, #414, #416, #417, #418) erano
    // tutte e sei rosse su questi due file, per contenuto che nessuna di loro
    // aveva scritto. Il terzo è quello che la #267 nominava.
    for (const must of [
      'generator/tests/seo-clause-truncation.test.mjs',
      'generator/tests/telelavoro-frontalieri-normative-citations.test.mjs',
      'generator/tests/article-fabrication-guard.test.mjs',
    ]) {
      assert.ok(CONTENT_GATES.includes(must), `${must} non è più nella lista dei gate`);
    }
  });

  test('nessun duplicato: `node --test` lo eseguirebbe due volte', () => {
    assert.equal(new Set(CONTENT_GATES).size, CONTENT_GATES.length);
  });
});

describe('content-gates-main: niente falso verde', () => {
  test('un albero senza `content/` fa fallire il preflight', () => {
    // In un worktree sparse `content/` non esiste affatto, ed è il falso verde
    // più facile da produrre su questo repo. Stessa forma del sotto-test
    // «niente falso verde su sparse checkout» di
    // telelavoro-frontalieri-normative-citations.test.mjs e dei pavimenti di
    // check-blog-body-syntax.mjs, che questo preflight RIUSA invece di
    // riscrivere.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-gates-empty-'));
    try {
      const v = preflight(dir);
      assert.equal(v.ok, false, 'un albero vuoto è passato: il gate direbbe verde senza guardare');
      assert.ok(
        v.violations.some((m) => m.startsWith('TOTALE:')),
        `il pavimento sul TOTALE non è scattato:\n  ${v.violations.join('\n  ')}`,
      );
      assert.ok(
        v.violations.some((m) => m.startsWith('content/blog-articles-data.ts')),
        'un registro assente non è stato segnalato: i gate che lo leggono per nome ' +
          'passerebbero su un file vuoto',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('il corpus vero passa il preflight', () => {
    const v = preflight();
    assert.deepEqual(v.violations, [], 'il preflight rifiuta il corpus reale');
    assert.ok(v.perRoot.every((r) => r.count > 0));
  });

  test('ogni file richiesto è dichiarato con un path sotto content/', () => {
    assert.ok(REQUIRED_FILES.length >= 12);
    assert.deepEqual(REQUIRED_FILES.filter((f) => !f.startsWith('content/')), []);
  });
});

describe('content-gates-main: il titolo dell\'alert', () => {
  test('sopravvive al taglio a 60 caratteri del dedup', () => {
    // `searchSafePrefix()` taglia a 60 e BUTTA il token spezzato dal taglio.
    // Un titolo che mettesse il discriminante in fondo collasserebbe su un
    // prefisso generico e dedupplicherebbe sulla issue sbagliata — che è peggio
    // che aprirne una nuova.
    assert.ok(
      TITLE.length <= 60,
      `Il titolo è ${TITLE.length} caratteri: oltre 60 il dedup lavora su un prefisso, e ` +
        'il resto non discrimina più niente.',
    );
    assert.ok(
      TITLE.slice(0, 30).includes('content') && TITLE.slice(0, 30).includes('main'),
      `Il discriminante non è nei primi 30 caratteri: "${TITLE}"`,
    );
  });

  test('non contiene caratteri che rompono la phrase search di gh', () => {
    // Il dedup usa il titolo dentro `gh issue list --search 'in:title "<frase>"'`.
    assert.ok(!/[/*"']/.test(TITLE), `caratteri fragili nel titolo: "${TITLE}"`);
  });

  test('non contiene numeri: sarebbe una issue nuova a ogni run', () => {
    assert.ok(!/\d/.test(TITLE), `il titolo porta una misura: "${TITLE}"`);
  });
});

describe('content-gates-main: la diagnosi finisce nella issue', () => {
  const TAP = [
    'TAP version 13',
    'not ok 1 - generator/tests/seo-clause-truncation.test.mjs',
    '    not ok 3 - content/seo/** — code aperte su una parola funzionale',
    '      ---',
    "      error: 'content/seo/seo-blog-4.ts: coda aperta su «della»'",
    '      ...',
    'not ok 2 - generator/tests/telelavoro-frontalieri-normative-citations.test.mjs',
    '    not ok 1 - nessuna occorrenza di «LFW»',
    "      error: 'content/blog-body/de/telelavoro.ts nomina LFW'",
    'ok 3 - generator/tests/blog-title-casing.test.mjs',
  ].join('\n');

  test('i nomi dei test falliti e i file sono su due piani distinti', () => {
    const { tests, files } = parseTapFailures(TAP);
    assert.deepEqual(files, [
      'generator/tests/seo-clause-truncation.test.mjs',
      'generator/tests/telelavoro-frontalieri-normative-citations.test.mjs',
    ]);
    assert.deepEqual(tests, [
      'content/seo/** — code aperte su una parola funzionale',
      'nessuna occorrenza di «LFW»',
    ]);
    assert.deepEqual(parseTapFailures('ok 1 - tutto bene'), { tests: [], files: [] });
  });

  test('gli offender sono estratti dai messaggi, non dal log intero', () => {
    assert.deepEqual(extractOffenders(TAP), [
      'content/blog-body/de/telelavoro.ts',
      'content/seo/seo-blog-4.ts',
    ]);
    assert.deepEqual(extractOffenders('nessun path qui'), []);
  });

  test('il corpo nomina gli offender e resta sotto il tetto di GitHub', () => {
    const body = buildIssueBody({
      failures: parseTapFailures(TAP),
      offenders: extractOffenders(TAP),
      perRoot: [{ rel: 'content/blog-body', count: 13372 }],
      runUrl: 'https://example.invalid/run/1',
      sha: 'deadbeef',
    });
    assert.match(body, /content\/seo\/seo-blog-4\.ts/);
    assert.match(body, /nessuna occorrenza di «LFW»/);
    assert.match(body, /deadbeef/);
    assert.ok(body.length < 60000, 'il corpo supera il tetto del body di una issue');
  });

  test('un corpo senza offender lo DICE, invece di sembrare vuoto', () => {
    const body = buildIssueBody({
      failures: { tests: [], files: [] },
      offenders: [],
      perRoot: [],
      runUrl: null,
      sha: null,
    });
    assert.match(body, /vedi il log della run/);
  });
});

/**
 * ── La quinta forma: `tests.yml` deve dare un verdetto su `main` ────────────
 *
 * Non è questo workflow, ma è l'unico posto dove la dipendenza è osservabile.
 * `pr-autorebase.mjs` (mode `identical`) legge
 * `actions/workflows/tests.yml/runs?branch=main` — keyed sul NOME del file,
 * quindi nessun workflow affiancato può sostituirlo — e senza una run
 * `completed` + `success` lì sopra il rescue `stuck-red/red-main` non concede
 * mai niente. Misurato il 2026-08-18: `total_count = 0` su 849 run, per
 * costruzione, ed è così che cinque PR sono rimaste bloccate in uno stato
 * assorbente.
 *
 * È un contratto senza forma di import: `loop-references-exist.test.mjs` segue
 * le citazioni testuali, non questa.
 */
describe('tests.yml: il verdetto su main che il rescue stuck-red legge', () => {
  test('`push` non esclude più `main`', () => {
    const onBlock = TESTS_WF.slice(TESTS_WF.indexOf('\non:'), TESTS_WF.indexOf('\npermissions:'));
    assert.ok(
      !/branches-ignore:\s*\[.*main.*\]/.test(onBlock),
      'Torna `branches-ignore: [main]`: `mainTestsRuns()` tornerebbe di nuovo a zero e il ' +
        'rescue `stuck-red/red-main` di pr-autorebase resterebbe spento in silenzio — nessuna ' +
        'run rossa, nessun errore, solo PR che non si sbloccano.',
    );
    assert.match(onBlock, /\n\s+push:/, 'il trigger `push` è sparito del tutto');
  });

  test('su main le run NON si cancellano a vicenda', () => {
    const m = TESTS_WF.match(/\nconcurrency:\n\s+group:\s*(.+)\n\s+cancel-in-progress:\s*(.+)/);
    assert.ok(m, 'blocco `concurrency:` non trovato in tests.yml');
    const cancel = m[2].trim();
    assert.ok(
      cancel !== 'true',
      'Con `cancel-in-progress: true` incondizionato le run su `main` (che avanza ogni ~8 ' +
        'minuti per la generazione articoli) si cancellano a vicenda. `mainTestsRuns()` filtra ' +
        '`status=completed` e `conclusion == success`: una run cancellata non è né l\'una né ' +
        `l'altra, quindi il conteggio resterebbe 0 con un trigger in più a far credere il ` +
        `contrario. Trovato: ${cancel}`,
    );
    assert.ok(
      m[1].includes('main'),
      `Il group non distingue più \`main\` dagli altri branch: ${m[1]}`,
    );
  });
});

describe('content-gates-main: la lista e\' COMPLETA, non solo non vuota', () => {
  // ── IL BUCO CHE QUESTI TEST CHIUDONO ─────────────────────────────────────
  //
  // I test qui sopra verificano che la lista non sia vuota, che i file
  // elencati esistano e che non ci siano duplicati. Sono tutte proprieta'
  // DELLA LISTA. Nessuna dice niente del suo RAPPORTO con la cartella dei
  // test — cioe' se qualcosa che legge il corpus sia rimasto fuori.
  //
  // Il costo, misurato il 2026-08-19:
  // `article-topic-coverage-guard.test.mjs` legge il corpus reale e non era
  // registrato. Alle 07:27Z e' atterrato `vivere-villa-guardia-lavorare-ticino`
  // — «Villa Guardia» e' un comune, «guardia» l'alias di `agente-sicurezza` —
  // e il test e' diventato rosso su `main` e su OGNI branch. Nessuna PR poteva
  // auto-mergiare, e siccome il gate non era registrato NESSUNA ISSUE e' stata
  // aperta: sei ore di coda ferma in silenzio. Registrato, la stessa
  // pubblicazione apre una issue a priorita' alta entro minuti e il fixer la
  // drena da solo.
  //
  // «Non e' un content gate» e «nessuno ha guardato» erano indistinguibili. E'
  // la stessa ambiguita' che `loop-sync-manifest.json` chiude coi `roots`.

  const TESTS_DIR = path.join(ROOT, 'generator/tests');
  const rilevati = () => detectCorpusReaders(TESTS_DIR);

  test('ogni file che legge il corpus e\' registrato OPPURE esentato con una ragione', () => {
    const registrati = new Set(CONTENT_GATES);
    const esentati = new Set(Object.keys(NON_SONO_CONTENT_GATES));
    const orfani = rilevati()
      .filter(({ file }) => !registrati.has(file) && !esentati.has(file));
    assert.deepEqual(
      orfani.map(({ file, why }) => `${file}  (${why})`),
      [],
      'Questi test leggono il corpus REALE e nessuno ha deciso cosa sono.\n' +
        'Un articolo pubblicato puo\' renderli rossi su main e su ogni branch, e\n' +
        'senza registrazione la coda di merge si ferma SENZA che si apra una issue.\n' +
        'Delle due:\n' +
        '  - e\' un gate sul contenuto  -> aggiungilo a CONTENT_GATES;\n' +
        '  - i path sono stringhe attese -> aggiungilo a NON_SONO_CONTENT_GATES con la ragione.',
    );
  });

  test('il rilevatore non e\' vacuo: vede la maggior parte dei gate registrati', () => {
    // Senza questo, un regex che smettesse di agganciare renderebbe il test
    // sopra verde per vacuita' — zero rilevati, zero orfani — proprio mentre
    // la copertura sparisce. E' la stessa guardia che `CONTENT_GATES.length
    // >= 10` mette sulla lista, applicata al metodo che la misura.
    const visti = new Set(rilevati().map(({ file }) => file));
    const registratiVisti = CONTENT_GATES.filter((g) => visti.has(g));
    assert.ok(
      registratiVisti.length >= Math.ceil(CONTENT_GATES.length * 0.8),
      `Il rilevatore vede solo ${registratiVisti.length} dei ${CONTENT_GATES.length} ` +
        'gate registrati. Sotto questa soglia non sta piu\' misurando niente, e il ' +
        'test di completezza sopra diventa una tautologia.',
    );
  });

  test('ogni esenzione nomina un file che esiste ED e\' davvero rilevato', () => {
    // Un\'esenzione per un file che il rilevatore non vede e\' peggio che
    // inutile: sopravvive a una riscrittura del file e continua a coprirlo
    // quando magari e\' diventato un lettore vero.
    const visti = new Set(rilevati().map(({ file }) => file));
    for (const [file, ragione] of Object.entries(NON_SONO_CONTENT_GATES)) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `esentato ma inesistente: ${file}`);
      assert.ok(visti.has(file), `esentato ma non rilevato — l\'esenzione e\' morta: ${file}`);
      assert.ok(
        typeof ragione === 'string' && ragione.length >= 40,
        `l\'esenzione di ${file} non porta una ragione leggibile`,
      );
    }
  });

  test('contiene il gate che il difetto del 2026-08-19 ha prodotto dal vivo', () => {
    // Stessa forma del test sui tre gate del 2026-08-18: un caso reale non si
    // affida a una regola generale per non tornare.
    assert.ok(
      CONTENT_GATES.includes('generator/tests/article-topic-coverage-guard.test.mjs'),
      'article-topic-coverage-guard non e\' piu\' fra i gate: e\' quello che il ' +
        '2026-08-19 ha tenuto ferma la coda di merge per sei ore senza aprire una issue.',
    );
  });
});
