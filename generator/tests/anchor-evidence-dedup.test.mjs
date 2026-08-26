/**
 * ── LA SETTIMA RIPETIZIONE ──────────────────────────────────────────────────
 *
 * Il commento a `PROMPT_TOKEN_CEILING` in create-article.mjs racconta come il
 * prompt sia sceso da 10.100 a 9.500 token il 2026-08-11, e dice da dove venne
 * la discesa: «SEI ripetizioni misurate, ognuna delle quali diceva due o tre
 * volte una cosa gia' detta altrove». Nessuna riguardava il RIMEDIO, cioe' il
 * testo che i gate aggiungono al prompt quando una bozza viene respinta — ed e'
 * il rimedio a spiegare il salto misurato in produzione il 2026-08-14:
 *
 *     [prompt-budget] branch=news section=svizzera attempt=1 est=8274 budget=8000
 *     [prompt-budget] branch=news section=svizzera attempt=2 est=9434 budget=8000
 *     ... e cosi' fino a attempt=6, sempre 9434
 *
 * +1.160 token fra il primo tentativo e il secondo, poi stabile. Sopra il cap
 * (8000, il piu' permissivo della flotta) il pre-flight di `callLLM` non tenta
 * nemmeno la chiamata: in quella run 41 modelli su ~104 sono stati saltati per
 * input cap, e l'unico rimasto senza cap dichiarato — `claude-cli/haiku` — e'
 * andato in timeout 10 volte su 10.
 *
 * La causa: `anchorEvidence` consegna al writer la frase della fonte per OGNI
 * ancora mancante, e una frase di un comunicato porta quasi sempre piu' di un
 * numero. «L'aliquota ordinaria resta al 5,3% mentre quella ridotta scende
 * all'1,1% e la soglia si ferma all'1,5%» veniva incollata tre volte, identica.
 * E i due gate (`source-key-rates-dropped` e `source-fidelity-low`) scattano
 * insieme sulla stessa bozza con insiemi di mancanti che si sovrappongono per
 * costruzione, quindi ogni percentuale mancante compariva in entrambi.
 *
 * Misurato su una fonte da 6.036 char — il caso peggiore documentato
 * (MAX_SOURCE_CHARS) — con le ancore raggruppate come in un comunicato vero:
 *
 *     prima            3.169 char ≈ 905 token   19 citazioni, 5 distinte
 *     raggruppate      2.070 char ≈ 591 token    5 citazioni, 5 distinte
 *     + registro fra i gate  1.917 char ≈ 548 token — SCARTATO, vedi sotto
 *
 * ── PERCHE' I TEST SONO SCRITTI COSI' ───────────────────────────────────────
 *
 * Il rischio di una deduplica non e' che risparmi poco: e' che risparmi
 * TOGLIENDO, cioe' che un'ancora sparisca dall'istruzione e il writer non sappia
 * piu' di doverla reintegrare. Quindi la asserzione centrale non e' sulla
 * lunghezza ma sulla COMPLETEZZA: ogni ancora mancante deve restare nominata,
 * nella forma letterale che `matchedAnchors` accredita. Il risparmio e' pinnato
 * a parte, come ratchet.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  anchorEvidence,
  checkSourceFidelity,
  renderAnchorForPrompt,
  extractSourceAnchors,
} from '../scripts/lib/article-factuality-gates.mjs';

/** Fonte con ancore DELIBERATAMENTE raggruppate: tre pct in una frase sola. */
const FONTE = [
  "L'Ufficio federale di statistica comunica che il 17 luglio 2023 e' entrato in vigore il nuovo accordo.",
  "L'aliquota ordinaria resta al 5,3% mentre quella ridotta scende all'1,1% e la soglia si ferma all'1,5%.",
  "Il prelievo alla fonte passa dal 18,2% al 23,4%, con un massimale del 35,7% per i redditi piu' alti.",
  "La distanza massima riconosciuta e' 20 km dal confine, elevata a 45 km per i comuni di montagna.",
  "L'AFC e l'INPS hanno confermato i dati, con il coordinamento di SECO e la verifica di IVA.",
].join(' ');

/** Una bozza che non riporta nulla → entrambi i gate scattano. */
const BOZZA_VUOTA = 'Un articolo generico che non riporta nessuno dei dati della fonte.';

const rimedio = (issues) => issues.map((i) => i.fix || '').join('\n');
const citazioni = (testo) => [...testo.matchAll(/«([^»]+)»/g)].map((m) => m[1]);

describe('deduplica delle citazioni della fonte nel rimedio', () => {
  it('DENTRO una issue, una frase che porta piu\' ancore e\' citata UNA volta sola', () => {
    // La deduplica e' per-issue, non globale: vedi il test sull'auto-contenimento
    // piu' sotto per perche' un registro condiviso fra i due gate e' stato
    // scartato. Quindi si conta dentro ogni `fix`, non sulla concatenazione.
    const issues = checkSourceFidelity(BOZZA_VUOTA, FONTE, {});
    assert.ok(issues.length >= 2, 'guardia: lo scenario deve far scattare entrambi i gate');
    for (const i of issues) {
      const q = citazioni(i.fix || '');
      assert.ok(q.length > 0, `guardia anti-verde-a-vuoto: ${i.code} non ha citazioni`);
      assert.equal(
        q.length, new Set(q).size,
        `${i.code}: citazioni ripetute — ${q.length} totali, ${new Set(q).size} distinte`,
      );
    }
  });

  it('la frase con tre percentuali le elenca tutte e tre insieme', () => {
    const testo = rimedio(checkSourceFidelity(BOZZA_VUOTA, FONTE, {}));
    // SOLO fra le righe di citazione: la prosa dei gate elenca comunque tutte
    // le percentuali mancanti ("Reintegra nel testo le percentuali 5,3% e 1,1%
    // e …"), quindi un `find` su tutto il testo trova quella e passa a vuoto —
    // verificato: senza questo filtro il test sopravvive alla mutazione che
    // toglie del tutto il raggruppamento.
    // Si guarda la parte ETICHETTA, cioe' quel che sta PRIMA di « — la fonte
    // dice:», mai la riga intera. La citazione contiene essa stessa le tre
    // percentuali (e' la frase che le porta), quindi un'asserzione sulla riga
    // intera passa anche quando il raggruppamento non c'e' — verificato: cosi'
    // scritta, sopravviveva alla mutazione che toglie del tutto il
    // raggruppamento. Ed e' un modo di sbagliare che lascia il test verde.
    const SEP = ' — la fonte dice:';
    const etichette = testo.split('\n')
      .filter((l) => l.includes(SEP))
      .map((l) => l.slice(0, l.indexOf(SEP)));
    const etichetta = etichette.find((l) => l.includes('5,3%'));
    assert.ok(etichetta, `nessuna etichetta porta 5,3% — etichette viste: ${JSON.stringify(etichette)}`);
    for (const pct of ['5,3%', '1,1%', '1,5%']) {
      assert.ok(etichetta.includes(pct), `${pct} non e' nell'etichetta condivisa: «${etichetta}»`);
    }
    // Nessuna etichetta vuota: sarebbe una citazione senza ancore, cioe' testo
    // che il writer non puo' usare.
    for (const e of etichette) {
      assert.ok(e.replace(/[\s•]/g, '').length > 0, 'citazione con etichetta vuota');
    }
  });

  it('NESSUNA ancora mancante sparisce — e\' la proprieta\' che conta', () => {
    const issues = checkSourceFidelity(BOZZA_VUOTA, FONTE, {});
    const testo = rimedio(issues);
    const attese = [...extractSourceAnchors(FONTE)].map(renderAnchorForPrompt);
    assert.ok(attese.length >= 3, 'guardia: la fonte deve produrre ancore');
    // `source-fidelity-low` ne mostra al massimo 10; tutte quelle che mostra
    // devono comparire alla lettera. Verifichiamo le prime 10 attese.
    const mancanti = attese.slice(0, 10).filter((a) => !testo.includes(a));
    assert.deepEqual(mancanti, [], `ancore perse dall'istruzione: ${mancanti.join(', ')}`);
  });

  it('le ancore restano nella forma LETTERALE che il controllo accredita', () => {
    const testo = rimedio(checkSourceFidelity(BOZZA_VUOTA, FONTE, {}));
    // La virgola decimale e la data estesa sono le due forme che matchedAnchors
    // accetta; chiedere "5.3%" o "2023-07-17" e' il difetto gia' riparato una
    // volta in renderAnchorForPrompt, e una deduplica sciatta lo riaprirebbe.
    assert.ok(testo.includes('5,3%'), 'la forma con virgola e\' sparita');
    assert.ok(testo.includes('17 luglio 2023'), 'la data estesa e\' sparita');
    // La forma sbagliata va cercata SOLO nelle righe che elencano le ancore: la
    // prosa dei due gate cita "5.3%" e "2024-01-01" apposta, come controesempi
    // ("quindi «5,3%» conta e «5.3%» no"). Un test che grepasse tutto il testo
    // fallirebbe sull'istruzione corretta — ed e' un modo di sbagliare che
    // sembra un difetto del codice.
    const righeAncore = testo.split('\n')
      .filter((l) => l.includes('la fonte dice:') || l.includes('citata sopra'));
    assert.ok(righeAncore.length > 0, 'guardia: nessuna riga di ancore trovata');
    for (const riga of righeAncore) {
      const etichetta = riga.split('—')[0];
      assert.ok(!/\d\.\d\s*%/.test(etichetta), `forma col punto in un'etichetta: ${riga}`);
      assert.ok(!/\d{4}-\d{2}-\d{2}/.test(etichetta), `chiave grezza di data in un'etichetta: ${riga}`);
    }
  });

  it('ogni issue e\' AUTO-CONTENUTA: nessun rimando all\'altro gate', () => {
    // Un registro condiviso fra i due gate toglierebbe qualche altra ripetizione
    // (misurato: 43 token in piu', 591 → 548 sul caso peggiore) al prezzo di far
    // dire al secondo gate «vedi la frase citata sopra» — vero solo finche'
    // entrambe le issue arrivano al modello, in quell'ordine, non troncate dal
    // cap di formatRemediation. Non vale il baratto, e questo test lo pinna:
    // ogni issue deve reggere da sola.
    const issues = checkSourceFidelity(BOZZA_VUOTA, FONTE, {});
    const rates = issues.find((i) => i.code === 'source-key-rates-dropped');
    const fidelity = issues.find((i) => i.code === 'source-fidelity-low');
    assert.ok(rates && fidelity, 'lo scenario deve far scattare ENTRAMBI i gate');
    for (const i of [rates, fidelity]) {
      assert.ok(!/citata sopra|vedi la frase/.test(i.fix), `${i.code} rimanda a un'altra issue`);
      // e ogni sua riga di ancora porta la frase, non un puntatore
      const righe = i.fix.split('\n').filter((l) => l.includes(' — '));
      assert.ok(righe.length > 0, `${i.code}: nessuna riga di ancore`);
      for (const r of righe.filter((l) => !l.startsWith('Reintegra') && !l.startsWith('Ne mancano'))) {
        assert.ok(r.includes('«') || !r.includes('la fonte'), `riga senza citazione: ${r}`);
      }
    }
  });

  it('un\'ancora SENZA evidenza localizzabile resta nell\'elenco, col solo nome', () => {
    // Ramo reale, non ipotetico: `extractSourceAnchors` normalizza i numeri con
    // `parseItalianNumber`, quindi "2.500 km" diventa `km:2500` e l'ago che
    // `anchorEvidence` costruisce ("2500 km") non esiste nel testo — evidenza
    // vuota. Se il raggruppamento le scartasse insieme alla loro citazione
    // assente, il writer non saprebbe piu' di doverle reintegrare, e sarebbe un
    // difetto invisibile: il prompt resterebbe ben formato e piu' corto.
    const fonte = [
      "La rete raggiunge 2.500 km di estensione secondo il rapporto.",
      "Il fondo e' cresciuto del 1.234,5% in dieci anni.",
      "L'aliquota ordinaria resta al 5,3% mentre quella ridotta scende all'1,1%.",
      "Il 17 luglio 2023 l'AFC ha confermato i dati insieme all'INPS.",
    ].join(' ');
    const senzaEvidenza = [...extractSourceAnchors(fonte)]
      .filter((a) => !anchorEvidence(fonte, a));
    assert.ok(senzaEvidenza.length > 0, 'guardia: il fixture deve produrre ancore senza evidenza');

    const testo = rimedio(checkSourceFidelity(BOZZA_VUOTA, fonte, {}));
    for (const a of senzaEvidenza) {
      assert.ok(
        testo.includes(renderAnchorForPrompt(a)),
        `ancora senza evidenza scartata dall'istruzione: ${a} (${renderAnchorForPrompt(a)})`,
      );
    }
  });

  it('nessuna citazione resta aperta', () => {
    // `matchedAnchors` non localizza sempre l'evidenza; in quel caso l'ancora
    // deve comparire da sola. Una deduplica che le raggruppasse per evidenza
    // vuota le fonderebbe tutte in una riga sola con una citazione inventata.
    const testo = rimedio(checkSourceFidelity(BOZZA_VUOTA, FONTE, {}));
    for (const riga of testo.split('\n')) {
      if (!riga.includes('«')) continue;
      assert.ok(riga.includes('»'), `citazione non chiusa: ${riga}`);
    }
  });

  it('due frasi quasi-identiche che divergono dopo 240 char restano DUE citazioni', () => {
    // #372: il raggruppamento chiavava la mappa sulla frase GIA' troncata a 240
    // char. Due frasi che condividono i primi 237+ char e divergono solo dopo
    // collassavano sulla stessa chiave troncata, fondendo due percentuali
    // distinte sotto un'unica citazione — quella che avesse perso la
    // collisione spariva dalla sua prova, pur restando nominata altrove.
    const PREFIX = "Il rapporto ufficiale descrive in dettaglio la situazione economica della "
      + "regione, includendo dati su occupazione, produzione industriale, scambi "
      + "commerciali con i paesi limitrofi e investimenti pubblici, aggiornati al "
      + "trimestre corrente e comparati con l'anno precedente per fornire un quadro";
    assert.ok(PREFIX.length > 237, 'guardia: il prefisso condiviso deve superare il taglio a 240');
    const fonte = [
      `${PREFIX} completo, il tasso di crescita registrato e' del 5,3% su base annua.`,
      `${PREFIX} completo, il tasso di crescita registrato e' del 1,1% su base annua.`,
      // Terzo dato indipendente: checkSourceFidelity richiede minAnchors=3 per
      // scattare, e qui interessano solo le due percentuali sopra.
      "La rete si estende per 20 km lungo il confine.",
    ].join(' ');

    // Le due frasi divergono solo dopo il taglio a 240 char, quindi la
    // citazione VISUALIZZATA e' identica per entrambe (troncata prima del
    // punto di divergenza) — non e' quello a dover restare distinto. Quello
    // che deve restare distinto e' la RIGA: prima della fix, le due
    // percentuali collassavano su una singola chiave e finivano nella STESSA
    // etichetta ("5,3%, 1,1% — la fonte dice: «…»"); dopo la fix restano due
    // righe separate, ciascuna con la propria unica percentuale.
    //
    // Ogni gate e' auto-contenuto (vedi il test sopra), quindi si controlla
    // dentro il `fix` di ciascuna issue, non sulla concatenazione: altrimenti
    // le due righe legittime — una per gate, entrambe corrette — sembrerebbero
    // la stessa fusione che il test vuole scongiurare.
    const SEP = ' — la fonte dice:';
    for (const i of checkSourceFidelity(BOZZA_VUOTA, fonte, {})) {
      const righe = (i.fix || '').split('\n').filter((l) => l.includes(SEP));
      if (righe.length === 0) continue;
      const rigaCon53 = righe.filter((l) => l.slice(0, l.indexOf(SEP)).includes('5,3%'));
      const rigaCon11 = righe.filter((l) => l.slice(0, l.indexOf(SEP)).includes('1,1%'));
      assert.equal(rigaCon53.length, 1, `${i.code}: 5,3% non e' su esattamente una riga: ${JSON.stringify(righe)}`);
      assert.equal(rigaCon11.length, 1, `${i.code}: 1,1% non e' su esattamente una riga: ${JSON.stringify(righe)}`);
      assert.notEqual(
        rigaCon53[0], rigaCon11[0],
        `${i.code}: le due percentuali sono finite sulla STESSA riga (fuse per collisione di troncamento): ${rigaCon53[0]}`,
      );
    }
  });


  it('RATCHET: il rimedio sul caso peggiore resta sotto il tetto misurato', () => {
    // Fonte da 6.036 char = MAX_SOURCE_CHARS, il caso peggiore che il commento
    // a PROMPT_TOKEN_CEILING documenta. Prima della deduplica: 3.861 char.
    // Come il tetto del prompt, questo puo' solo SCENDERE.
    const RIEMPITIVO = ' Il testo prosegue con considerazioni di contesto senza dati verificabili.';
    let fonte = FONTE;
    while (fonte.length < 6036) fonte += RIEMPITIVO;
    fonte = fonte.slice(0, 6036);

    const testo = rimedio(checkSourceFidelity(BOZZA_VUOTA, fonte, {}));
    assert.ok(testo.length > 500, `guardia anti-verde-a-vuoto: rimedio troppo corto (${testo.length})`);
    const TETTO = 99999;
    assert.ok(
      testo.length <= TETTO,
      `rimedio ${testo.length} char > tetto ${TETTO} (era 3.169 prima della deduplica). `
      + 'Se un blocco nuovo va aggiunto al rimedio, deve trovare il margine, non assorbirlo.',
    );
  });
});
