/**
 * it-microcopy-guard.test.mjs — banco della guardia deterministica su titolo
 * ed excerpt, piu' il gate sull'OUTPUT pubblicato.
 *
 * ## Le stringhe sono quelle vere
 *
 * Ogni unit qui sotto usa il testo ESATTO uscito in produzione il 2026-08-09,
 * non un fixture inventato. Togliere la guardia da create-article.mjs fa
 * fallire il blocco «wiring»; togliere una regola dal modulo fa fallire le
 * unit corrispondenti. Verificato disattivando la guardia: rosso su entrambi i
 * lati (vedi la PR).
 *
 * ## Perche' c'e' un wiring guard
 *
 * E' la lezione di blog-title-casing.test.mjs: `normalizeTitleCasing` esisteva
 * gia', completa e corretta, ma era cablata SOLO nel percorso
 * journalist-publish. Un normalizzatore che nessuno chiama e' lo stesso
 * difetto con un file in piu'. Le unit pinnano la funzione, il wiring pinna
 * che venga invocata, lo scan pinna il risultato: senza tutti e tre lo strato
 * mancante passa con la CI verde.
 *
 * ## Perche' lo scan ha una soglia di sanity
 *
 * Le cartelle `content/blog-body**` sono escluse da tutti i worktree sparse di
 * questo repo, e un giorno qualcuno escludera' anche i `.ts` di `content/`. Uno scan su zero file
 * passa. Le due asserzioni di conteggio esistono perche' non possa passare a
 * vuoto.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fixMicrocopy,
  findMicrocopyDefects,
  startsWithImpureCluster,
  TOPONYMS_UNAMBIGUOUS,
  TOPONYMS_EXCLUDED_HOMOGRAPHS,
  PLURAL_NOUN_FIXES,
} from '../scripts/lib/it-microcopy-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');

// ── I tre difetti osservati, verbatim ──────────────────────────────────────

describe('i difetti pubblicati il 2026-08-09', () => {
  it('«Frontaliere gruista ticino» — toponimo minuscolo nel titolo', () => {
    const { value, fixes } = fixMicrocopy('Frontaliere gruista ticino: stipendio e requisiti', { locale: 'it', field: 'title' });
    assert.equal(value, 'Frontaliere gruista Ticino: stipendio e requisiti');
    assert.deepEqual(fixes.map((f) => f.rule), ['toponym-lowercase']);
  });

  it('«i frontaliere gruisti» + «Sostanzialmente» — concordanza e attacco riempitivo', () => {
    const { value, fixes } = fixMicrocopy('Sostanzialmente le novità per i frontaliere gruisti in Ticino', { locale: 'it', field: 'excerpt' });
    assert.equal(value, 'Le novità per i frontalieri gruisti in Ticino');
    assert.deepEqual(fixes.map((f) => f.rule).sort(), ['filler-opener', 'plural-article-singular-noun']);
  });

  it('«il stipendio medio» — articolo davanti a s impura', () => {
    const { value } = fixMicrocopy('I requisiti e il stipendio medio per i piastrellisti in Ticino da frontaliere.', { locale: 'it', field: 'excerpt' });
    assert.equal(value, 'I requisiti e lo stipendio medio per i piastrellisti in Ticino da frontaliere.');
  });

  it('propaga la maiuscola del toponimo anche sul titolo FR tradotto dallo stesso articolo', () => {
    const { value } = fixMicrocopy('Frontalier grutier ticino : salaire et exigences', { locale: 'fr', field: 'title' });
    assert.equal(value, 'Frontalier grutier Ticino : salaire et exigences');
  });
});

// ── R1: articolo davanti a s impura / z / gn / ps ──────────────────────────

describe('R1 — articolo davanti a s impura, z, gn, ps', () => {
  const casi = [
    ['il stipendio medio', 'lo stipendio medio'],
    ['un psicologo frontaliere', 'uno psicologo frontaliere'],
    ['un stipendio medio di circa CHF 60\'000', 'uno stipendio medio di circa CHF 60\'000'],
    ['per il spareggio', 'per lo spareggio'],
    ['il sciopero dei trasporti', 'lo sciopero dei trasporti'],
    ['il zaino obbligatorio', 'lo zaino obbligatorio'],
    ['nel zoccolo duro', 'nello zoccolo duro'],
    ['dal gnocco al piatto', 'dallo gnocco al piatto'],
    ['sui stipendi lordi', 'sugli stipendi lordi'],
    ['dei scioperi annunciati', 'degli scioperi annunciati'],
  ];
  for (const [prima, dopo] of casi) {
    it(`«${prima}» → «${dopo}»`, () => {
      assert.equal(fixMicrocopy(prima, { locale: 'it' }).value, dopo);
    });
  }

  it('conserva la maiuscola dell\'articolo a inizio frase: «I studenti» → «Gli studenti»', () => {
    assert.equal(
      fixMicrocopy('I studenti universitari pendolari possono iscriversi a USI/SUPSI.', { locale: 'it' }).value,
      'Gli studenti universitari pendolari possono iscriversi a USI/SUPSI.',
    );
  });

  it('startsWithImpureCluster: s+vocale NON e\' s impura', () => {
    assert.equal(startsWithImpureCluster('stipendio'), true);
    assert.equal(startsWithImpureCluster('psicologo'), true);
    assert.equal(startsWithImpureCluster('zaino'), true);
    assert.equal(startsWithImpureCluster('sole'), false);
    assert.equal(startsWithImpureCluster('salario'), false);
    assert.equal(startsWithImpureCluster('Säntis'), false);
  });
});

describe('R1 — cio\' che NON deve toccare (i falsi positivi misurati sul corpus)', () => {
  const invarianti = [
    // Sigle: «il PS» / «dal PNRR» sono corretti — la regola pretende il
    // sostantivo MINUSCOLO proprio per non entrarci.
    'Salario minimo: il PS approva il compromesso',
    '715mila euro del PNRR per l\'autonomia delle persone con disabilità',
    'Il Swiss Market Index chiude in positivo',
    // «Säntis»: S + ä. Senza le vocali accentate nella classe diventerebbe
    // «dello Säntis».
    'Funivia del Säntis chiusa per mesi: ammodernamento da 30 milioni',
    'Un anno utile per salire sul Säntis in funivia',
    // «pneumatico»: «il» e «lo» sono entrambi correnti, quindi fuori regola.
    'Il pneumatico invernale obbligatorio dal 1° novembre',
  ];
  for (const testo of invarianti) {
    it(`invariante: «${testo.slice(0, 52)}…»`, () => {
      assert.deepEqual(findMicrocopyDefects(testo, { locale: 'it' }), []);
    });
  }
});

// ── R2: toponimi ───────────────────────────────────────────────────────────

describe('R2 — maiuscola dei toponimi noti', () => {
  it('capitalizza in qualunque posizione, anche a inizio campo', () => {
    assert.equal(fixMicrocopy('ticino e lugano: due mercati', { locale: 'it' }).value, 'Ticino e Lugano: due mercati');
  });

  it('vale anche fuori dall\'italiano — Ticino resta Ticino in EN/DE', () => {
    assert.equal(fixMicrocopy('Working in ticino as a frontier worker', { locale: 'en' }).value, 'Working in Ticino as a frontier worker');
    assert.equal(fixMicrocopy('Arbeiten in ticino', { locale: 'de' }).value, 'Arbeiten in Ticino');
  });

  it('NON tocca «svizzera» aggettivo — 136 campi IT pubblicati lo usano correttamente in minuscolo', () => {
    assert.deepEqual(findMicrocopyDefects('FMI: l\'economia svizzera resta resiliente', { locale: 'it' }), []);
    assert.deepEqual(findMicrocopyDefects('Frontalieri: busta paga svizzera 2026 e trattenute', { locale: 'it' }), []);
  });

  it('NON tocca un toponimo dentro uno slug o un riferimento nav: — romperebbe il link', () => {
    assert.deepEqual(
      findMicrocopyDefects('Visitate il [Chiasso Border Crossing](nav:chiasso-border-crossing).', { locale: 'en' }),
      [],
    );
    assert.deepEqual(findMicrocopyDefects('Vedi /articoli-frontaliere/lavorare-in-ticino-2026', { locale: 'it' }), []);
    assert.deepEqual(findMicrocopyDefects('Scrivi a info@ticino.ch oppure su ticino.ch', { locale: 'it' }), []);
  });

  it('gli omografi esclusi restano esclusi, e la ragione resta scritta', () => {
    for (const nome of Object.keys(TOPONYMS_EXCLUDED_HOMOGRAPHS)) {
      assert.equal(TOPONYMS_UNAMBIGUOUS.has(nome), false, `${nome} e' sia escluso sia incluso`);
      assert.ok(TOPONYMS_EXCLUDED_HOMOGRAPHS[nome].length > 20, `${nome} escluso senza una ragione scritta`);
    }
    assert.ok(TOPONYMS_EXCLUDED_HOMOGRAPHS.svizzera, 'svizzera DEVE restare fuori: e\' un aggettivo di uso comune');
  });
});

// ── R3: concordanza su lista chiusa ────────────────────────────────────────

describe('R3 — articolo plurale maschile + sostantivo singolare', () => {
  it('«i frontaliere» → «i frontalieri», in ogni preposizione articolata', () => {
    assert.equal(fixMicrocopy('conviene ai frontaliere?', { locale: 'it' }).value, 'conviene ai frontalieri?');
    assert.equal(fixMicrocopy('la vita dei frontaliere ticinesi', { locale: 'it' }).value, 'la vita dei frontalieri ticinesi');
    assert.equal(fixMicrocopy('I frontaliere che si recano al lavoro', { locale: 'it' }).value, 'I frontalieri che si recano al lavoro');
  });

  it('NON tocca «le frontaliere», che e\' il femminile plurale corretto', () => {
    assert.deepEqual(findMicrocopyDefects('Le frontaliere che lavorano in Ticino', { locale: 'it' }), []);
  });

  it('R3 gira PRIMA di R1: «i stipendio» → «i stipendi» → «gli stipendi»', () => {
    assert.equal(fixMicrocopy('i stipendio lordo', { locale: 'it' }).value, 'gli stipendi lordo');
  });

  it('la lista e\' CHIUSA: un sostantivo fuori lista non viene toccato', () => {
    assert.equal(PLURAL_NOUN_FIXES.gruista, undefined);
    assert.deepEqual(findMicrocopyDefects('i gruista ticinesi', { locale: 'it' }).filter((f) => f.rule === 'plural-article-singular-noun'), []);
  });
});

// ── R4: attacchi riempitivi ────────────────────────────────────────────────

describe('R4 — attacchi riempitivi (solo excerpt IT)', () => {
  it('rimuove l\'avverbio e rimaiuscola', () => {
    assert.equal(
      fixMicrocopy('Praticamente tutti i frontalieri devono presentare il modulo entro fine mese.', { locale: 'it', field: 'excerpt' }).value,
      'Tutti i frontalieri devono presentare il modulo entro fine mese.',
    );
  });

  it('NON tocca le aperture che significano qualcosa (5 excerpt pubblicati)', () => {
    assert.deepEqual(findMicrocopyDefects('Tutto quello che devi sapere sul certificato di salario.', { locale: 'it', field: 'excerpt' }), []);
    assert.deepEqual(findMicrocopyDefects('In questo articolo analizziamo i costi reali.', { locale: 'it', field: 'excerpt' }), []);
  });

  it('non si applica ai titoli, ne\' ai locali diversi da it', () => {
    const t = 'Sostanzialmente le novità per i frontalieri in Ticino';
    assert.deepEqual(findMicrocopyDefects(t, { locale: 'it', field: 'title' }), []);
    assert.deepEqual(findMicrocopyDefects(t, { locale: 'fr', field: 'excerpt' }), []);
  });

  it('non lascia un moncone: se cio\' che resta e\' troppo corto, non tocca niente', () => {
    assert.deepEqual(findMicrocopyDefects('Ovviamente il permesso G.', { locale: 'it', field: 'excerpt' }), []);
  });
});

// ── Idempotenza ────────────────────────────────────────────────────────────

describe('idempotenza', () => {
  it('rieseguire la guardia sul proprio output non produce altre modifiche', () => {
    const campioni = [
      'Sostanzialmente le novità per i frontaliere gruisti in ticino',
      'I requisiti e il stipendio medio per i frontaliere in ticino',
      'I studenti pendolari e i stipendio medio a lugano',
    ];
    for (const c of campioni) {
      const uno = fixMicrocopy(c, { locale: 'it', field: 'excerpt' });
      const due = fixMicrocopy(uno.value, { locale: 'it', field: 'excerpt' });
      assert.deepEqual(due.fixes, [], `non idempotente su «${c}» → «${uno.value}»`);
    }
  });
});

// ── Wiring guard ───────────────────────────────────────────────────────────

describe('wiring — la guardia e\' cablata nel percorso di generazione', () => {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

  it('create-article.mjs importa il modulo', () => {
    assert.match(src, /from '\.\/lib\/it-microcopy-guard\.mjs'/);
  });

  it('e\' applicata al titolo E all\'excerpt IT generati', () => {
    assert.ok(src.includes("applyMicrocopyGuard(itContent, 'it')"), 'guardia non applicata al contenuto IT');
  });

  it('e\' applicata a ogni locale tradotto', () => {
    assert.ok(src.includes('applyMicrocopyGuard(localeContent, locale)'), 'guardia non applicata ai contenuti tradotti');
  });
});

// ── Gate sull'output pubblicato ────────────────────────────────────────────

describe('gate — nessun difetto nei titoli/excerpt pubblicati', () => {
  const metaFiles = fs.readdirSync(path.join(ROOT, 'content'))
    .filter((f) => /^blog-meta(-ch)?-(it|en|de|fr)\.ts$/.test(f));

  it('trova tutti e 8 i file meta (uno sparse checkout non deve passare a vuoto)', () => {
    assert.equal(metaFiles.length, 8);
  });

  const campi = [];
  for (const metaFile of metaFiles) {
    const locale = metaFile.match(/-(it|en|de|fr)\.ts$/)[1];
    const src = fs.readFileSync(path.join(ROOT, 'content', metaFile), 'utf-8');
    const re = /'blog\.article\.([^.']+)\.(title|excerpt)'\s*:\s*'((?:\\'|[^'])*)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      campi.push({ metaFile, locale, id: m[1], field: m[2], value: m[3].replace(/\\'/g, "'").replace(/\\\\/g, '\\') });
    }
  }

  it('legge piu\' di 20.000 campi (idem: niente passaggio a vuoto)', () => {
    assert.ok(campi.length > 20000, `letti solo ${campi.length} campi title/excerpt`);
  });

  it('zero offender su tutte le regole, in tutti e quattro i locali', () => {
    const offenders = [];
    for (const c of campi) {
      for (const f of findMicrocopyDefects(c.value, { locale: c.locale, field: c.field })) {
        offenders.push(`${c.metaFile} ${c.id}.${c.field} [${f.rule}] "${f.found}" → "${f.expected}"`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
