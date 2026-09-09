/**
 * normative-acronym-collateral-ratchet.test.mjs — issue #332
 *
 * #323/#324/#325 hanno bonificato `LFW` e `LPS` (31 citazioni fabbricate,
 * ora zero) e messo le quattro sigle provate in `FABRICATED_NORM_ACRONYMS`
 * (`LFW`, `LPS`, `LCL`, `LCO`). Le sigle incontrate NELLE STESSE FRASI sono
 * state lasciate fuori di proposito, "per non mescolare una bonifica misurata
 * con una non misurata" — e da allora non le ha contate nessuno. #332 chiede
 * esattamente questo primo passo: la misura, non la bonifica.
 *
 * QUESTO FILE NON E' UN GATE DI FABBRICAZIONE. Nessuna di queste dieci sigle e'
 * provata fabbricata, e almeno una collide con una sigla svizzera reale (`LTF` =
 * Legge sul Tribunale federale, RS 173.110). Metterle nella denylist oggi
 * rigetterebbe 175 file gia' pubblicati su un sospetto — l'errore che #323 ha
 * evitato apposta. Quello che si puo' fare senza un verdetto editoriale e'
 * impedire che la classe CRESCA mentre il verdetto manca: e' un ratchet, e i
 * numeri sotto sono un massimale, non un bersaglio.
 *
 * Cosa fa scattare il rosso: un articolo NUOVO che introduce una di queste
 * sigle. Cosa NON fa scattare il rosso: i file gia' pubblicati, che restano
 * esattamente dove sono finche' qualcuno non decide.
 *
 * SI MISURA SU `HEAD`, NON SUL WORKING TREE. In un worktree sparse `content/`
 * non e' materializzato, e un `git grep` sul disco tornerebbe zero su tutto —
 * cioe' un gate verde che non ha guardato niente. `git grep <sigla> HEAD` legge
 * l'oggetto tree e da' lo stesso numero in sparse e in CI (verificato: 103 vs 0
 * per `LTF` fra i due modi, nello stesso worktree).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Massimali misurati su `origin/main` il 2026-09-09, in FILE distinti che
 * contengono la sigla come parola intera sotto `content/`.
 *
 * Comando grezzo (uno per sigla, riproducibile a mano):
 *   git grep -a -w -n -- <SIGLA> HEAD -- content/
 *
 * `-a`: i file del corpus contengono byte che git tratterebbe come binari, e
 * senza questo flag il conteggio torna zero senza dirlo (stessa trappola gia'
 * misurata su `create-article.mjs` per `grep`).
 * `-w`: confine di parola, che e' cio' che esclude i falsi positivi da sigle
 * piu' lunghe — `MLPS` e `TULPS` contengono `LPS`, e senza `-w` gonfiavano la
 * misura di #323. Git considera pero' `-` un separatore, quindi il risultato
 * viene filtrato a livello di occorrenza: si scarta SOLO il composto non
 * normativo `JSON-LD` (vedi `COMPOSTI_NON_NORMATIVI`). Un composto normativo
 * come `LTF-TI` o `L-LD` conta, perche' e' esattamente la classe che questo
 * ratchet impedisce di far crescere: scartare ogni sigla adiacente a `-`
 * renderebbe invisibile un futuro `LSO-TI` o `LPF-CH` e il gate morirebbe
 * verde. Il grezzo va quindi post-filtrato: il comando sopra da' le RIGHE, il
 * massimale conta i FILE distinti che restano dopo il filtro.
 *
 * Scostamento dai numeri del body di #332 (misurati intorno al 2026-08-16):
 * LTF 89→103 file, RPS 10→10, LSO 8→8, LPF 9→6, LPST 4→4. Le occorrenze totali
 * sono invece SCESE (LTF 138→110): il corpus e' cambiato in mezzo. E' il motivo
 * per cui il ratchet vive qui e non nel body di una issue — un numero scritto
 * in prosa scade, questo si rimisura a ogni run.
 */
const MASSIMALE_FILE = {
  LTF: 103,
  RPS: 10,
  LSO: 8,
  LPF: 6,
  LPST: 4,
  RFW: 1,
  LPSPS: 1,
  // PR #1276 aveva alzato `LD` da 13 a 17 per le quattro traduzioni di
  // `nestle-ai-consumatori-ricerca` (quattro occorrenze tutte `JSON-LD`);
  // questa PR (#1277) conserva la ragione storica ma esclude `JSON-LD` dal
  // conteggio. Restano contate le due occorrenze di `L-LD`, che e' una
  // citazione normativa.
  LD: 10,
  LSS: 26,
  BWG: 3,
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * I SOLI composti che non sono una citazione normativa, quindi i soli da
 * scartare. Tutto il resto conta: `LTF-TI` («la legge ticinese sulla
 * tassazione dei redditi da lavoro (LTF-TI)») e `L-LD` («Legge sul lavoro
 * domestico (L-LD) del 20 marzo 2019») portano la cue di citazione attaccata e
 * sono la classe che #332 misura.
 */
const COMPOSTI_NON_NORMATIVI = new Set(['JSON-LD']);

/**
 * Caratteri che tengono insieme un composto. Oltre all'hyphen ASCII ci sono i
 * trattini tipografici: il corpus e' prosa in quattro lingue e contiene gia'
 * `L\u2011LD` con un non-breaking hyphen. Senza queste varianti un `JSON\u2011LD`
 * si leggerebbe come `LD` autonomo e alzerebbe il contatore per un carattere,
 * non per un articolo nuovo.
 */
const CARATTERE_DI_TOKEN = /[A-Za-z0-9_\u002d\u00ad\u2010-\u2015\u2212]/;
const TRATTINI = /[\u00ad\u2010-\u2015\u2212]/g;

/** Il composto intero attorno all'occorrenza, con i trattini normalizzati a `-`. */
function tokenAttorno(riga, index, lunghezza) {
  let inizio = index;
  while (inizio > 0 && CARATTERE_DI_TOKEN.test(riga[inizio - 1])) inizio -= 1;
  let fine = index + lunghezza;
  while (fine < riga.length && CARATTERE_DI_TOKEN.test(riga[fine])) fine += 1;
  return riga.slice(inizio, fine).replace(TRATTINI, '-').toUpperCase();
}

/** Un'occorrenza conta a meno che il composto che la contiene non sia normativo. */
function haOccorrenzaDaContare(riga, sigla) {
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(sigla)}(?![A-Za-z0-9_])`, 'g');
  return [...riga.matchAll(pattern)].some(
    ({ index }) => !COMPOSTI_NON_NORMATIVI.has(tokenAttorno(riga, index, sigla.length)),
  );
}

/** File distinti sotto `content/` che contengono la sigla fuori dai composti non normativi. */
const fileConSiglaCache = new Map();
function fileConSigla(sigla) {
  if (fileConSiglaCache.has(sigla)) return fileConSiglaCache.get(sigla);

  try {
    const out = execFileSync(
      'git',
      ['grep', '-a', '-w', '-n', '--', sigla, 'HEAD', '--', 'content/'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const files = new Set();
    for (const riga of out.split('\n').filter(Boolean)) {
      if (!riga.startsWith('HEAD:')) throw new Error(`Formato inatteso di git grep: ${riga}`);
      const senzaRef = riga.slice('HEAD:'.length);
      const primoSeparatore = senzaRef.indexOf(':');
      const secondoSeparatore = senzaRef.indexOf(':', primoSeparatore + 1);
      if (primoSeparatore < 0 || secondoSeparatore < 0) throw new Error(`Formato inatteso di git grep: ${riga}`);
      const file = senzaRef.slice(0, primoSeparatore);
      const testo = senzaRef.slice(secondoSeparatore + 1);
      if (haOccorrenzaDaContare(testo, sigla)) files.add(file);
    }

    const conteggio = files.size;
    fileConSiglaCache.set(sigla, conteggio);
    return conteggio;
  } catch (e) {
    // `git grep` esce 1 quando non trova NIENTE: e' un risultato, non un guasto.
    if (e.status === 1) {
      fileConSiglaCache.set(sigla, 0);
      return 0;
    }
    throw e;
  }
}

for (const [sigla, massimale] of Object.entries(MASSIMALE_FILE)) {
  test(`#332: \`${sigla}\` non si diffonde oltre i ${massimale} file misurati`, () => {
    const oggi = fileConSigla(sigla);
    assert.ok(
      oggi <= massimale,
      `\`${sigla}\` compare ora in ${oggi} file di content/ fuori da \`JSON-LD\` (massimale ${massimale}, misurato il 2026-09-09).\n` +
        `Un articolo nuovo ha introdotto una sigla normativa che nessuno ha ancora verificato come reale o fabbricata (#332).\n` +
        `Rimisura con: git grep -a -w -n -- ${sigla} HEAD -- content/, scarta le sole occorrenze dentro \`JSON-LD\` e conta i FILE distinti che restano.\n` +
        `Se la sigla e' REALE, alza il massimale qui con la misura nel commit. Se e' FABBRICATA, va in FABRICATED_NORM_ACRONYMS di generator/scripts/lib/article-factuality-gates.mjs, non qui.`,
    );
  });
}

test('#332: solo i composti non normativi non contano', () => {
  assert.equal(haOccorrenzaDaContare('schema JSON-LD', 'LD'), false);
  assert.equal(haOccorrenzaDaContare('schema JSON\u2011LD', 'LD'), false);
  assert.equal(haOccorrenzaDaContare('sigla LD', 'LD'), true);
  assert.equal(haOccorrenzaDaContare('JSON-LD e LD', 'LD'), true);
  // I composti NORMATIVI restano contati: sono la classe che il ratchet
  // difende, e scartarli renderebbe verde l'articolo che introduce `LSO-TI`.
  assert.equal(haOccorrenzaDaContare('tassazione dei redditi da lavoro (LTF-TI)', 'LTF'), true);
  assert.equal(haOccorrenzaDaContare('Legge sul lavoro domestico (L-LD) del 20 marzo 2019', 'LD'), true);
  assert.equal(haOccorrenzaDaContare('Legge sul lavoro domestico (L\u2011LD)', 'LD'), true);
  assert.equal(haOccorrenzaDaContare('un futuro LSO-TI', 'LSO'), true);
});

test('#332: il ratchet non e\' vacuo — almeno una sigla e\' davvero contata', () => {
  // Difesa contro il modo in cui questo gate morirebbe in silenzio: `git grep`
  // che smette di trovare (path cambiato, `-a` tolto, `content/` spostato)
  // renderebbe ogni asserzione sopra un `0 <= N` sempre vero. Se il corpus
  // ripulisse davvero TUTTE e dieci le sigle, questa riga va tolta insieme al
  // resto del file — non e' un invariante da difendere, e' un canarino.
  const totale = Object.keys(MASSIMALE_FILE).reduce((n, s) => n + fileConSigla(s), 0);
  assert.ok(
    totale > 0,
    'zero occorrenze su tutte e dieci le sigle: piu' + "' probabile che la misura si sia rotta che il corpus si sia bonificato da solo",
  );
});

test('#332: nessuna di queste sigle e\' (ancora) nella denylist di fabbricazione', () => {
  // Guard di CONFINE, non di contenuto. Se un giorno una di queste sigle viene
  // provata fabbricata e finisce in FABRICATED_NORM_ACRONYMS, il gate vero la
  // rigetta e il massimale qui diventa una seconda verita' che dice il
  // contrario. Meglio che il file cada e costringa a togliercela.
  return import('../scripts/lib/article-factuality-gates.mjs').then(({ FABRICATED_NORM_ACRONYMS }) => {
    const inDenylist = new Set((FABRICATED_NORM_ACRONYMS || []).map((e) => String(e.acronym).toUpperCase()));
    const doppie = Object.keys(MASSIMALE_FILE).filter((s) => inDenylist.has(s));
    assert.deepEqual(
      doppie,
      [],
      `${doppie.join(', ')} e' ora in FABRICATED_NORM_ACRONYMS: il gate di fabbricazione la rigetta gia', togli la riga dal ratchet di #332 invece di tenere due verita' in disaccordo`,
    );
  });
});
