/**
 * Osservatore del tetto `TESTIMONE_GIRI_MAX` sul corpus REALE — issue #404.
 * `node --test`. Registrato come content gate (`scripts/ci/content-gates-main.mjs`).
 *
 * ── LA DECISIONE CHE QUESTO FILE RENDE VERIFICABILE ────────────────────────
 *
 * #404 chiedeva di sostituire il tetto con «un vero punto fisso», e diceva
 * anche cosa serviva prima di decidere: *«quanti file superano oggi il tetto
 * nel corpus reale, quale sarebbe il costo di un ciclo `while` a convergenza
 * reale»*. Quella misura ora esiste, presa il 2026-08-25 su `origin/main`:
 *
 *     npx -y tsx@4 generator/scripts/repair-mangled-chars.mjs --json
 *
 *     19.588 file esaminati · 26 con marker · 223 occorrenze · 0 riparate
 *     escapate: 45 occorrenze, 0 riparate, 45 lasciate
 *     residui:  46 lasciati
 *     occorrenze lasciate col motivo del tetto: **ZERO**
 *
 * I 223 rifiuti si dividono in quattro motivi — «nessuna prova» (163),
 * «non e' una lettera» (30), «troppi marker nel token» (18), «ambiguo» (12) —
 * e i 91 fra escapate e residui in tre, tutti della forma «nessun testimone».
 * NESSUNO e' il tetto. Il tetto non lega, e non lega con margine: perche'
 * leghi servono >4 riparazioni APPLICATE in un file, e oggi le riparazioni
 * applicate sono **0 su tutti e tre i canali**.
 *
 * Quindi la decisione, presa qui invece di restare parcheggiata (VISION.md
 * D1 — reversibile + misurato + osservato):
 *
 *   **il tetto resta 4, e questo file e' l'osservatore che lo giustifica.**
 *
 * Sostituirlo con un ciclo a punto fisso oggi sarebbe un cambio di
 * comportamento su un ramo che non viene MAI percorso: zero beneficio
 * misurabile, e rischio non zero — questo script riscrive `content/`, e una
 * riparazione sbagliata e' IRREVERSIBILE (appena il byte C0 sparisce nessuno
 * sa piu' quale carattere ci fosse; vedi l'intestazione di
 * `repair-mangled-chars.test.mjs`). VISION.md D2 dice di non toccare una
 * soglia per intuizione; qui la misura dice che la soglia non e' nemmeno in
 * gioco.
 *
 * ── COSA FA QUESTO TEST, E PERCHE' NON E' RIDONDANTE ───────────────────────
 *
 * `repair-mangled-chars.test.mjs` copre gia' il COMPORTAMENTO al tetto, con
 * fixture sintetiche: che nessuna occorrenza sparisca, che il motivo dica
 * «rilanciare lo script», che un secondo giro ripari il resto. Quelli restano
 * i test della meccanica e non li tocco.
 *
 * Cio' che NON esisteva e' l'osservatore sul dato vero: niente diceva se il
 * tetto stesse legando **in produzione**. La misura sopra e' un fotogramma;
 * senza un guard, il giorno in cui il corpus cambia forma e il tetto comincia
 * a mordere, la decisione «resta 4» diventerebbe sbagliata **in silenzio** —
 * e la si scoprirebbe solo da un residuo che non converge, cioe' dal sintomo
 * che #366 e #386 esistono per rendere visibile.
 *
 * Il patto e' quindi: finche' questo test e' verde, «il tetto resta 4» e' una
 * decisione MISURATA. Il giorno che diventa rosso, non e' un difetto da
 * silenziare alzando il numero (D2): e' l'evidenza che #404 aspettava, e a
 * quel punto il punto fisso si progetta su un caso reale invece che su
 * un'ipotesi.
 *
 * ── PERCHE' UN CONTENT GATE, E NON UN GATE DI PR ───────────────────────────
 *
 * Legge il corpus generato dai bot (~90 push/giorno su `main`), che nessuna PR
 * scrive e nessun autore di PR puo' riparare. Renderlo rosso su `pull_request`
 * sarebbe esattamente l'incidente del 2026-08-19 —
 * `vivere-villa-guardia-lavorare-ticino`, sei ore di coda ferma. Registrato in
 * `CONTENT_GATES`, gira su `main` e apre UNA issue deduplicata, dove il dato
 * c'e' e il segnale e' azionabile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// L'ancora e' scritta in UNA riga, `path.resolve(...import.meta.url...)`, e non
// passando per una `QUI = path.dirname(...)` intermedia: e' la forma che
// `detectCorpusReaders()` (scripts/ci/content-gates-main.mjs) sa riconoscere.
// Con l'indirezione questo file risultava REGISTRATO ma INVISIBILE al
// rilevatore — cioe' esattamente il silenzio che quel rilevatore esiste per
// impedire, solo dal lato che non fa scattare nessun test.
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'generator', 'scripts', 'repair-mangled-chars.mjs');
const CORPUS = path.join(ROOT, 'content');

/**
 * Il tetto si legge DAL SORGENTE, non si ricopia qui.
 *
 * Una costante duplicata a mano si separa dall'originale senza che niente lo
 * dica, ed e' proprio la classe di difetto che questo file esiste per
 * sorvegliare: un test che confronta il corpus con un 4 scritto qui resterebbe
 * verde anche dopo che qualcuno ha portato il vero tetto a 40.
 */
function tettoDichiarato() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const m = src.match(/^const TESTIMONE_GIRI_MAX = (\d+);$/m);
  assert.ok(m, 'TESTIMONE_GIRI_MAX non si legge piu\' dal sorgente: se e\' stato rinominato o '
    + 'sostituito da un punto fisso, questo osservatore va aggiornato o rimosso INSIEME alla modifica, '
    + 'non lasciato a fallire per un motivo che non e\' quello che sorveglia');
  return Number(m[1]);
}

/**
 * Il rapporto vero sul corpus vero. Dry-run: non tocca un byte.
 *
 * Memoizzato: la passata costa ~40s su 19.588 file (misurata), e i due test
 * qui sotto leggono lo STESSO rapporto — rifarla sarebbe un minuto e mezzo di
 * gate per un dato identico.
 */
let memo = null;
function rapportoDelCorpus() {
  if (memo) return memo;
  memo = eseguiRapporto();
  return memo;
}

function eseguiRapporto() {
  try {
    return JSON.parse(execFileSync('node', [SCRIPT, '--root', ROOT, '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (e) {
    // Uscita 2 = «resta qualcosa da riparare», che oggi e' lo stato normale
    // (223 rifiuti per mancanza di prove). Il rapporto e' su stdout comunque,
    // ed e' quello che conta: qui non si giudica se il corpus e' pulito, si
    // giudica se il TETTO ha legato.
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  }
}

/** Il motivo che `riparaEscapate` scrive quando esce col lavoro ancora in mano. */
const MOTIVO_TETTO = /tetto di \d+ riparazioni per file raggiunto/;

test('preflight: il corpus reale c\'e\' (un albero assente renderebbe vacuo tutto il resto)', () => {
  assert.ok(fs.existsSync(CORPUS), `${CORPUS} non esiste: in un worktree sparse questo gate non ha `
    + 'guardato niente, e un verde qui sarebbe una bugia');
  const quanti = fs.readdirSync(CORPUS).length;
  assert.ok(quanti >= 10, `content/ ha ${quanti} voci: troppo poche perche' il rapporto significhi qualcosa`);
});

test('il tetto TESTIMONE_GIRI_MAX non lega su nessun file del corpus reale (#404)', () => {
  const tetto = tettoDichiarato();
  const r = rapportoDelCorpus();

  // ── 1. Il canale escapato lo DICHIARA: si legge il motivo, non si deduce.
  const escapateAlTetto = (r.escapate?.elenco || []).filter((x) => MOTIVO_TETTO.test(x.motivo || ''));
  assert.deepEqual(
    escapateAlTetto.map((x) => `${x.file}:${x.offset}`), [],
    `${escapateAlTetto.length} occorrenze escapate sono risolvibili ma non applicate perche' il tetto `
    + `di ${tetto} giri e' stato raggiunto. Il tetto ha cominciato a legare: e' l'evidenza che #404 `
    + 'aspettava. NON alzare il numero per far tornare verde questo test (VISION.md D2) — la strada e\' '
    + 'il punto fisso vero, ora progettabile su un caso reale.',
  );

  // ── 2. Stesso controllo sul canale residuo.
  const residuiAlTetto = (r.residui?.lasciate || []).filter((x) => MOTIVO_TETTO.test(x.motivo || ''));
  assert.deepEqual(
    residuiAlTetto.map((x) => `${x.file}:${x.offset ?? '?'}`), [],
    `${residuiAlTetto.length} residui non applicati per il tetto di ${tetto} giri.`,
  );

  // ── 3. Il canale testimone NON dichiara niente al tetto, e va misurato in
  // un altro modo.
  //
  // `riparaConTestimoni()` esce dal `for` a `TESTIMONE_GIRI_MAX` e ritorna:
  // nessun `lasciate`, nessun motivo — la fix di #386 ha coperto
  // `riparaEscapate()`, non lui. Cio' che gli avanza NON sparisce dal rapporto
  // (porta ancora il byte C0, quindi ricompare fra le `rifiutate` del canale
  // principale), ma ci ricompare con il motivo SBAGLIATO: sembra mancanza di
  // prove quando invece era il tetto.
  //
  // L'unico segnale disponibile e' quindi il conteggio: il tetto puo' aver
  // legato solo su un file che ha raggiunto `tetto` riparazioni APPLICATE.
  // Sotto quel numero il ciclo si e' fermato da solo per punto fisso, che e'
  // il comportamento voluto. E' un limite superiore, non una misura esatta —
  // ma e' conservativo nel verso giusto: segnala prima, mai dopo.
  const sospetti = [];
  for (const f of r.perFile || []) {
    if ((f.riparate ?? 0) >= tetto) sospetti.push(`${f.file} (canale testimone/principale: ${f.riparate})`);
  }
  for (const f of r.escapate?.perFile || []) {
    if ((f.riparate ?? 0) >= tetto) sospetti.push(`${f.file} (canale escapato: ${f.riparate})`);
  }
  for (const f of r.residui?.perFile || []) {
    if ((f.riparati ?? 0) >= tetto) sospetti.push(`${f.file} (canale residuo: ${f.riparati})`);
  }
  assert.deepEqual(
    sospetti, [],
    `Questi file hanno raggiunto il tetto di ${tetto} riparazioni applicate in una sola passata, quindi `
    + 'il ciclo puo\' essere uscito per il tetto invece che per punto fisso — e sul canale testimone '
    + 'quell\'uscita non e\' dichiarata, quindi cio\' che avanza si presenta col motivo sbagliato. '
    + 'Rilanciare lo script converge lo stesso (il tetto e\' per-passata), ma la decisione «il tetto '
    + 'resta 4» di #404 non e\' piu\' sostenuta dalla misura che la reggeva.',
  );
});

test('il filtro sul motivo NON e\' vacuo: su un albero che il tetto lo raggiunge davvero, matcha', () => {
  // ── PERCHE' QUESTO TEST ESISTE ────────────────────────────────────────────
  //
  // I due filtri qui sopra cercano una stringa. Il giorno che qualcuno
  // riscrive il messaggio di `riparaEscapate` — anche solo «limite» al posto
  // di «tetto» — smettono di trovare qualunque cosa e restano verdi PER
  // SEMPRE, avendo guardato niente. Sarebbe un osservatore che non osserva:
  // esattamente il modo di rompersi di `list-pr-gate-tests.mjs` con una lista
  // vuota, e la ragione per cui quello script esce !=0 invece di stampare
  // poco.
  //
  // Qui il tetto viene raggiunto SUL SERIO, su un albero temporaneo, e si
  // verifica che `MOTIVO_TETTO` lo riconosca. Se il messaggio cambia, rosso
  // qui — dove la causa e' ovvia — invece che un verde muto sul corpus vero.
  //
  // La fixture e' quella di `repair-mangled-chars.test.mjs`: sei frasi
  // distinte (piu' del tetto), l'ancora di 16 caratteri finisce col numero
  // della frase quindi nessuna e' ambigua, e un testimone in un altro locale
  // porta la forma pulita.
  const E = (n) => `\\\\u${n.toString(16).padStart(4, '0')}`;
  const PAROLE = ['dépenses', 'Dépenses', 'réduit', 'contrôle', 'financière', 'délais',
    'évolution', 'marché', 'première', 'conçues', 'Municipalité', 'à', 'Der'];
  const QUANTE = 6;
  const numeri = Array.from({ length: QUANTE }, (_, i) => i + 1);
  const prima = (k) => `frase numero ${k} dello stesso documento, caso ${k}: `;
  const dopo = (k) => ` una faccenda che il lettore numero ${k} conosce bene.`;

  const radice = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-tetto-'));
  try {
    fs.mkdirSync(path.join(radice, 'content', 'blog-body', 'it'), { recursive: true });
    fs.mkdirSync(path.join(radice, 'content', 'blog-body', 'de'), { recursive: true });
    fs.writeFileSync(path.join(radice, 'content', 'pulito.ts'),
      `${PAROLE.join(' ')}\n${PAROLE.join(' ')}\n`);
    fs.writeFileSync(path.join(radice, 'content', 'blog-body', 'it', 'sporco.ts'),
      `${numeri.map((k) => `${prima(k)}${E(0x16)}5${dopo(k)}`).join('\n')}\n`);
    fs.writeFileSync(path.join(radice, 'content', 'blog-body', 'de', 'testimone.ts'),
      `${numeri.map((k) => `${prima(k)}è${dopo(k)}`).join('\n')}\n`);

    let rapporto;
    try {
      rapporto = JSON.parse(execFileSync('node', [SCRIPT, '--root', radice, '--json', '--write'],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    } catch (e) {
      if (!e.stdout) throw e;
      rapporto = JSON.parse(e.stdout);
    }

    const tetto = tettoDichiarato();
    const e = rapporto.escapate;
    assert.equal(e.occorrenze, QUANTE, 'la fixture deve avere piu\' occorrenze del tetto');
    assert.equal(e.riparate, tetto, `il tetto ha legato: ${tetto} riparazioni e non una di piu'`);
    assert.equal(e.lasciate, QUANTE - tetto, 'il resto dev\'essere DICHIARATO, non sparito');

    const conMotivo = (e.elenco || []).filter((x) => MOTIVO_TETTO.test(x.motivo || ''));
    assert.equal(
      conMotivo.length, QUANTE - tetto,
      'MOTIVO_TETTO non riconosce piu\' il messaggio che lo script produce davvero al tetto. '
      + `Prodotti: ${JSON.stringify((e.elenco || []).map((x) => x.motivo))}. I due filtri sul corpus `
      + 'reale sono quindi VACUI: verdi perche\' non trovano niente, non perche\' non c\'e\' niente. '
      + 'Aggiorna la regexp INSIEME al messaggio.',
    );
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('la misura di riferimento di #404 e\' riproducibile: il rapporto ha la forma che il gate legge', () => {
  // Un rapporto che cambia forma (chiave rinominata, canale rimosso) renderebbe
  // i filtri qui sopra vacui: `[] === []` su un campo che non esiste piu' passa
  // verde avendo guardato nulla. E' lo stesso modo di rompersi di
  // `list-pr-gate-tests.mjs` con una lista vuota.
  const r = rapportoDelCorpus();
  assert.equal(r.modalita, 'dry-run', 'il gate non deve mai scrivere sul corpus');
  for (const chiave of ['fileTotali', 'occorrenze', 'riparate', 'rifiutate', 'perFile']) {
    assert.ok(chiave in r, `il rapporto non ha piu' '${chiave}': i controlli sul tetto sono diventati vacui`);
  }
  assert.ok(Array.isArray(r.escapate?.elenco), 'escapate.elenco non e\' piu\' un array');
  assert.ok(Array.isArray(r.escapate?.perFile), 'escapate.perFile non e\' piu\' un array');
  assert.ok(Array.isArray(r.residui?.lasciate), 'residui.lasciate non e\' piu\' un array');
  assert.ok(Array.isArray(r.residui?.perFile), 'residui.perFile non e\' piu\' un array');
  assert.ok(r.fileTotali > 1000, `fileTotali = ${r.fileTotali}: il gate ha guardato un corpus amputato`);
});
