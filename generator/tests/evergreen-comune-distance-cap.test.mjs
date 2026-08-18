/**
 * Osservatore del pool evergreen strutturale.
 *
 * ## Perche' esiste
 *
 * Il pool strutturale si e' dimezzato in silenzio. Il commit 7045b166
 * (2026-08-14) ha portato `buildStructuralEvergreenTopics()` da 310 a 155
 * candidati, il pool a runtime da 537 a 382, e la sezione `frontaliere` e'
 * andata in saturazione totale:
 *
 *   EVERGREEN_POOL_OUTCOME saturated=1 stage=preflight pool=382 checked=382
 *   status=skipped section=frontaliere        ← 32 dispatch su 32
 *
 * `checked == pool` significa zero keyword libere. La sezione e' scesa da 22
 * articoli il 13-08 a 4 il 15-08, contro i 31-99 di `svizzera` che gira sulla
 * stessa catena. Niente e' diventato rosso: un pool che si restringe non e'
 * un fallimento visibile, e' solo meno roba che esce.
 *
 * Quel commit e' passato con la CI verde perche' NESSUN test guardava la
 * taglia del pool. Questo file e' quel test mancante. Non ricontrolla la
 * fix del cap: controlla la grandezza che la fix ha spostato, cosi' il
 * prossimo dimezzamento arriva come un rosso invece che come un calo di
 * pubblicazione da diagnosticare a mano tre giorni dopo.
 *
 * ## Nota su come gira
 *
 * Sotto `node --test` puro, senza tsx. Il modulo importa `.ts`
 * (`../data/municipalities.ts`), e fino a Node 22.18 quello richiedeva un
 * loader — e' la ragione per cui `evergreen-pool-svizzera.test.mjs` ricostruisce
 * il suo oggetto con `new Function` sul sorgente e dichiara il pool
 * strutturale «non caricabile qui». Non e' piu' vero: lo strip dei tipi e'
 * attivo di default, e la CI di questo repo gira `node-version: '22'`, che
 * oggi risolve a 22.23.2. Verificato importando il modulo con quel binario.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildComuneEvergreenTopics,
  buildProfessionEvergreenTopics,
  buildStructuralEvergreenTopics,
  resolveComuneCanton,
} from '../scripts/lib/evergreen-topic-generator.mjs';
import { comuneTopicKey, topicCoverageKey } from '../scripts/lib/topic-coverage-guard.mjs';
import { MUNICIPALITIES } from '../data/municipalities.ts';

/**
 * Il raggio dichiarato in `evergreen-topic-generator.mjs`. Ripetuto qui a
 * mano di proposito: importarlo renderebbe il test d'accordo con qualunque
 * valore, compreso uno rimesso a 5km per sbaglio.
 */
const EXPECTED_MAX_DISTANCE_KM = 30;

/**
 * Floor del pool strutturale. NON e' il conteggio esatto: il dataset dei
 * comuni cambia (25 righe SO→LC il 2026-08-10, #211) e un test che pretende
 * l'uguaglianza diventerebbe rosso a ogni correzione di un dato, che e' il
 * modo piu' rapido per farsi disattivare.
 *
 * 400 e' scelto per stare SOPRA i due valori che vanno respinti — 155 di oggi
 * e 310 di prima di 7045b166 — e SOTTO i 507 misurati, con ~100 di margine
 * per il drift del dataset. Un ritorno al cap a conteggio, in qualunque forma,
 * cade sotto questa soglia.
 */
const STRUCTURAL_POOL_FLOOR = 400;

describe('pool evergreen strutturale — taglia', () => {
  it(`non e' collassato: almeno ${STRUCTURAL_POOL_FLOOR} candidati`, () => {
    const pool = buildStructuralEvergreenTopics();
    assert.ok(
      pool.length >= STRUCTURAL_POOL_FLOOR,
      `pool strutturale a ${pool.length} candidati, sotto il floor di ${STRUCTURAL_POOL_FLOOR}. ` +
        'Un pool che si restringe non fallisce da solo: satura la sezione e la pubblicazione ' +
        'cala senza che niente diventi rosso (7045b166 → saturated=1 pool=382 checked=382). ' +
        'Se il calo e\' voluto, la soglia va abbassata QUI, con la misura nel commit.',
    );
  });

  it('e\' esattamente professioni + comuni, senza perdite per strada', () => {
    const professioni = buildProfessionEvergreenTopics();
    const comuni = buildComuneEvergreenTopics();
    const pool = buildStructuralEvergreenTopics();
    assert.equal(pool.length, professioni.length + comuni.length);
    assert.ok(professioni.length > 0, 'meta\' professioni vuota');
    assert.ok(comuni.length > 0, 'meta\' comuni vuota');
  });

  it('ogni candidato ha keyword e angle non vuoti', () => {
    for (const t of buildStructuralEvergreenTopics()) {
      assert.equal(typeof t.keyword, 'string');
      assert.ok(t.keyword.length > 0);
      assert.equal(typeof t.angle, 'string');
      assert.ok(t.angle.length > 0);
    }
  });

  it('nessuna keyword duplicata: una keyword ripetuta e\' una slot sprecata, non un candidato', () => {
    const keywords = buildStructuralEvergreenTopics().map((t) => t.keyword);
    const seen = new Set();
    const dupes = [];
    for (const k of keywords) {
      if (seen.has(k)) dupes.push(k);
      seen.add(k);
    }
    assert.deepEqual(dupes, [], `keyword duplicate: ${dupes.join(', ')}`);
  });
});

describe('cap sulla distanza di pendolarismo', () => {
  it(`seleziona tutti e soli i comuni entro ${EXPECTED_MAX_DISTANCE_KM}km`, () => {
    const selezionati = new Set(
      buildComuneEvergreenTopics(MUNICIPALITIES).map((t) => t.keyword),
    );

    const attesi = MUNICIPALITIES.filter(
      (m) =>
        m?.name &&
        resolveComuneCanton(m) &&
        typeof m.distanceKm === 'number' &&
        m.distanceKm <= EXPECTED_MAX_DISTANCE_KM,
    );

    assert.equal(
      selezionati.size,
      attesi.length,
      `selezionati ${selezionati.size} comuni, ma ${attesi.length} stanno entro ${EXPECTED_MAX_DISTANCE_KM}km`,
    );

    for (const m of attesi) {
      const canton = resolveComuneCanton(m);
      assert.ok(
        selezionati.has(`vivere a ${m.name} e lavorare in ${canton} da frontaliere`),
        `${m.name} (${m.distanceKm}km, ${canton}) e' entro il raggio ma non e' nel pool`,
      );
    }
  });

  it('non e\' tornato a un cap per cantone: la soglia e\' la stessa in tutti e tre', () => {
    const perCantone = new Map();
    for (const m of MUNICIPALITIES) {
      const canton = resolveComuneCanton(m);
      if (!canton || !m?.name || typeof m.distanceKm !== 'number') continue;
      if (m.distanceKm > EXPECTED_MAX_DISTANCE_KM) continue;
      perCantone.set(canton, (perCantone.get(canton) ?? 0) + 1);
    }

    // Il difetto del cap a conteggio: a 40/25/20 la barra reale stava a ~5km
    // in Ticino e a ~20km in Vallese. Se un cantone perde comuni entro il
    // raggio, un tetto per cantone e' tornato — con qualunque nome.
    const selezionatiPerCantone = new Map();
    for (const t of buildComuneEvergreenTopics(MUNICIPALITIES)) {
      const canton = /lavorare in (\w+) da frontaliere$/.exec(t.keyword)?.[1];
      if (canton) selezionatiPerCantone.set(canton, (selezionatiPerCantone.get(canton) ?? 0) + 1);
    }

    for (const [canton, atteso] of perCantone) {
      assert.equal(
        selezionatiPerCantone.get(canton) ?? 0,
        atteso,
        `${canton}: ${selezionatiPerCantone.get(canton) ?? 0} selezionati su ${atteso} entro il raggio — ` +
          'un tetto per cantone e\' rientrato',
      );
    }
  });

  it('esclude i comuni fuori raggio, non li tiene con un altro nome', () => {
    const selezionati = new Set(buildComuneEvergreenTopics(MUNICIPALITIES).map((t) => t.keyword));
    const fuori = MUNICIPALITIES.filter(
      (m) =>
        m?.name &&
        resolveComuneCanton(m) &&
        typeof m.distanceKm === 'number' &&
        m.distanceKm > EXPECTED_MAX_DISTANCE_KM,
    );
    assert.ok(fuori.length > 0, 'nessun comune fuori raggio: il test non starebbe provando niente');
    for (const m of fuori) {
      const canton = resolveComuneCanton(m);
      assert.ok(
        !selezionati.has(`vivere a ${m.name} e lavorare in ${canton} da frontaliere`),
        `${m.name} e' a ${m.distanceKm}km, oltre il raggio, ma e' nel pool`,
      );
    }
  });
});

describe('chiavi di argomento: comuni e professioni non collidono', () => {
  /**
   * L'argomento gia' scritto in `create-article.mjs` — la geografia moltiplica,
   * la professione collassa — regge solo se le due meta' del pool cadono su
   * chiavi DISTINTE nel `topic-coverage-guard`. Se un candidato-comune finisse
   * classificato `profession-guide`, allargare la meta' geografica
   * consumerebbe il budget della meta' mestiere e la fix si mangerebbe da sola.
   *
   * ## Perche' si misura `topicCoverageKey` e non `professionTopicKey`
   *
   * Perche' e' `topicCoverageKey` a decidere in produzione, e le due cose
   * NON danno la stessa risposta. Misurato allargando il pool a 30km:
   * «vivere a Villa Guardia e lavorare in Ticino da frontaliere» fa scattare
   * `professionTopicKey` → `agente-sicurezza`, perche' `guardia` e' un alias
   * di quel mestiere e il comune si chiama cosi'. Preso da solo sembra una
   * collisione introdotta da questa PR — Villa Guardia entra nel pool solo
   * ora, sotto il cap a conteggio non c'era.
   *
   * Non lo e': `computeTopicCoverageKey` pretende la CONGIUNZIONE
   * (a) il testo nomina un mestiere AND (b) ha intento da guida al lavoro,
   * e l'angle di un candidato-comune parla di collegamenti, tempi di
   * percorrenza e costo della vita — `hasProfessionGuideIntent` e' falso.
   * Villa Guardia esce infatti come `comune-guide`, che e' corretto.
   *
   * E' esattamente la congiunzione che l'header del guard dice di aver messo
   * li' per questo. Il test la verifica al livello dove vive, cosi' una
   * regressione che la togliesse diventerebbe rossa qui — mentre un test sul
   * livello sotto sarebbe rosso oggi senza che niente sia rotto.
   */
  it('nessun candidato-comune viene classificato come guida-mestiere', () => {
    const collisioni = [];
    for (const t of buildComuneEvergreenTopics(MUNICIPALITIES)) {
      const chiave = topicCoverageKey({ title: t.keyword, id: '', excerpt: t.angle });
      if (chiave?.kind === 'profession-guide') {
        collisioni.push(`${t.keyword} → mestiere '${chiave.value}'`);
      }
    }
    assert.deepEqual(
      collisioni,
      [],
      `candidati-comune classificati come guida-mestiere:\n  ${collisioni.join('\n  ')}`,
    );
  });

  it('nessun candidato-mestiere viene classificato come guida-comune', () => {
    const collisioni = [];
    for (const t of buildProfessionEvergreenTopics()) {
      const chiave = topicCoverageKey({ title: t.keyword, id: '', excerpt: t.angle });
      if (chiave?.kind === 'comune-guide') {
        collisioni.push(`${t.keyword} → comune '${chiave.value}'`);
      }
    }
    assert.deepEqual(
      collisioni,
      [],
      `candidati-mestiere classificati come guida-comune:\n  ${collisioni.join('\n  ')}`,
    );
  });

  it('due candidati-comune non collassano mai sulla stessa chiave', () => {
    const chiavi = new Map();
    for (const t of buildComuneEvergreenTopics(MUNICIPALITIES)) {
      const chiave = comuneTopicKey(`${t.keyword} ${t.angle}`);
      if (!chiave) continue; // gli esclusi deliberati: vedi il test dopo
      if (chiavi.has(chiave)) {
        assert.fail(
          `chiave-comune '${chiave}' condivisa da due candidati: ` +
            `«${chiavi.get(chiave)}» e «${t.keyword}» — il guard ne bloccherebbe uno dei due`,
        );
      }
      chiavi.set(chiave, t.keyword);
    }
    assert.ok(chiavi.size > 0);
  });

  /**
   * `municipalityIndex()` scarta di proposito i nomi di una parola corti
   * (< 4 caratteri) o omografi di parole comuni — `AMBIGUOUS_COMUNE_TOKENS`,
   * con la misura accanto a ciascuno: «mese» 12/12 in «al mese», «premia»
   * 5/5 il verbo, «erba» 2/3 «erba sintetica». Un candidato per quei comuni
   * viene comunque emesso: semplicemente il guard non riesce a dedurne una
   * chiave, quindi non li deduplica.
   *
   * Va bene, ed e' una scelta del guard, non di questo file. Ma il conteggio
   * va fissato: se domani un comune NORMALE smette di produrre una chiave,
   * quello e' un guard che ha smesso di funzionare, e senza questa asserzione
   * si vedrebbe solo come duplicati pubblicati.
   */
  it('i soli comuni senza chiave sono quelli che il guard esclude apposta', () => {
    const senzaChiave = buildComuneEvergreenTopics(MUNICIPALITIES)
      .filter((t) => !comuneTopicKey(`${t.keyword} ${t.angle}`))
      .map((t) => /^vivere a (.+?) e lavorare in /.exec(t.keyword)?.[1])
      .sort();

    // Nomi di una parola: sotto i 4 caratteri (Bee, Re, Nus) o nella lista
    // degli omografi (Erba, Mese, Premia).
    assert.deepEqual(senzaChiave, ['Bee', 'Erba', 'Mese', 'Nus', 'Premia', 'Re']);

    for (const nome of senzaChiave) {
      const parole = nome.split(' ');
      assert.equal(
        parole.length,
        1,
        `${nome} ha piu' parole: il guard non dovrebbe scartarlo, pretende la sequenza completa`,
      );
    }
  });
});
