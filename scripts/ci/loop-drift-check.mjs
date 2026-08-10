#!/usr/bin/env node
/**
 * loop-drift-check.mjs — sorveglia la divergenza fra il ciclo autonomo di
 * questo repo e quello di `valerielinc-ops/frontaliere-si-o-no`, e per ogni
 * file divergente dice **perché** diverge.
 *
 * ## Il problema che risolve
 *
 * Il ciclo agentico è nato sul sito ed è stato portato qui. Da questo momento i
 * due lati evolvono in parallelo, e un diff a due vie ("i file sono diversi?")
 * non serve a niente: sono diversi **per costruzione**. `vitest` non esiste qui,
 * `npm ci` nemmeno, `functions/` neppure. Un checker a due vie segnalerebbe
 * quelle differenze per sempre, ogni giorno, finché nessuno lo guarda più.
 *
 * La domanda utile non è "sono diversi" ma "**chi si è mosso, e da quando**".
 *
 * ## Il confronto a tre vie
 *
 * Il manifest registra, per ogni file, l'hash di ENTRAMBI i lati al momento
 * dell'ultimo allineamento cosciente (la `baseline`). Con tre hash — sito oggi,
 * corpus oggi, baseline — la diagnosi diventa deterministica:
 *
 *   sito == baseline.site  &&  corpus == baseline.corpus  →  `stable`
 *       Nessuno si è mosso. Le differenze che restano sono quelle dichiarate.
 *
 *   sito != baseline.site  &&  corpus == baseline.corpus  →  `site-ahead`
 *       Il sito ha evoluto, qui no. È il caso che oggi passa inosservato: il
 *       mirror dell'engine ha già dimostrato che un canale di discesa che si
 *       interrompe non lo dice a nessuno — nove commit persi, visibili solo
 *       come un audit passato da 23 a 3608.
 *
 *   sito == baseline.site  &&  corpus != baseline.corpus  →  `corpus-ahead`
 *       Abbiamo migliorato qualcosa QUI. Non è drift da correggere: è una
 *       modifica candidata a risalire verso il sito. Senza questa classe, le
 *       ottimizzazioni locali restano invisibili e vengono cancellate al
 *       prossimo allineamento.
 *
 *   entrambi mossi                                        →  `both-moved`
 *       L'unico caso che richiede davvero un umano: due modifiche indipendenti
 *       sullo stesso file. Nessun merge automatico, per scelta.
 *
 * Un file `mode: "adapted"` non è esente dal confronto: è esente dal
 * REQUISITO DI UGUAGLIANZA. Continua a essere sorvegliato sulla baseline,
 * perché è proprio sui file adattati che una modifica del sito si perde più
 * facilmente — nessuno se ne accorge, visto che "tanto è diverso apposta".
 *
 * ## `corpus-only` vs `corpus-only-pending` (issue #125)
 *
 * `corpus-only` dice "non esiste sul sito" senza distinguere *non serve* da
 * *serve e manca*: la differenza viveva solo in prosa dentro `reason`, che non
 * fa fallire niente. `corpus-only-pending` è il grado che la rende un segnale:
 *
 *   - è sempre `actionable`, a differenza di `corpus-only` — finché il gemello
 *     non compare, c'è un lavoro tracciato (`entry.trackingIssue`) da seguire;
 *   - a differenza di `corpus-only`, QUESTO script interroga davvero il sito
 *     (`sitePath || path`): se il fetch smette di rispondere 404, il gemello è
 *     atterrato e lo stato diventa `corpus-only-pending-landed` — l'istruzione
 *     è promuovere la voce a mano (`identical`/`adapted` + `--init`), perché
 *     un contenuto appena arrivato può non essere ancora quello atteso;
 *   - se il lavoro tracciato viene abbandonato, la retromarcia è manuale: si
 *     toglie `trackingIssue` e si torna a `corpus-only`. Nessuno script lo fa
 *     da solo, per la stessa ragione per cui non mergia né riscrive: è una
 *     decisione, non una meccanica.
 *
 * ## Cosa NON fa
 *
 * Non mergia, non apre PR, non riscrive niente. Emette un report. La correzione
 * è una decisione, e questo script non ha il contesto per prenderla.
 *
 * Uso:
 *   node scripts/ci/loop-drift-check.mjs             # report leggibile + exit 0
 *   node scripts/ci/loop-drift-check.mjs --json      # report JSON su stdout
 *   node scripts/ci/loop-drift-check.mjs --strict    # exit 1 se c'è drift azionabile
 *   node scripts/ci/loop-drift-check.mjs --init      # (ri)registra le baseline correnti
 *
 * Env:
 *   SITE_REPO   default `valerielinc-ops/frontaliere-si-o-no`
 *   SITE_REF    default `main`
 *   GH_TOKEN    opzionale; senza, usa raw.githubusercontent (repo pubblico).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');
const SITE_REPO = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';
const SITE_REF = process.env.SITE_REF || 'main';

const ARGS = new Set(process.argv.slice(2));
const AS_JSON = ARGS.has('--json');
const STRICT = ARGS.has('--strict');
const INIT = ARGS.has('--init');
const AS_ISSUE = ARGS.has('--issue');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/** Hash del file locale, o null se non esiste. */
function localHash(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return sha256(fs.readFileSync(p));
}

/**
 * Contenuto del file dal sito al ref dato. Il repo è pubblico, quindi
 * raw.githubusercontent basta e non consuma rate-limit autenticato.
 * 404 → null (il file non esiste più là: è un segnale, non un errore).
 */
async function siteHash(rel) {
  const url = `https://raw.githubusercontent.com/${SITE_REPO}/${SITE_REF}/${rel}`;
  const headers = { 'User-Agent': 'loop-drift-check' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${rel} → HTTP ${res.status}`);
  return sha256(Buffer.from(await res.arrayBuffer()));
}

/**
 * Classifica UN file. Ritorna {state, actionable, headline, detail}.
 *
 * `actionable` distingue ciò che richiede una decisione da ciò che è solo
 * cronaca: un report che segnala tutto non viene letto.
 */
function classify(entry, now, base) {
  const { path: rel, mode, reason } = entry;

  if (mode === 'corpus-only') {
    return { state: 'corpus-only', actionable: false, headline: 'solo su questo repo', detail: reason || '' };
  }

  if (mode === 'corpus-only-pending') {
    // A differenza di `corpus-only`, qui `now.site` NON è forzato a null: il
    // fetch è stato eseguito davvero (vedi main()), perché la domanda utile è
    // proprio "è ancora assente?". Un 404 che persiste è lo stato normale
    // finché il lavoro tracciato non atterra — non un errore da segnalare come
    // `removed-on-site` (quel branch presume un file che ESISTEVA ed è stato
    // tolto, che è una storia diversa da "non è mai esistito").
    const tracking = entry.trackingIssue ? ` Tracciato in ${entry.trackingIssue}.` : ' ATTENZIONE: nessun `trackingIssue` dichiarato.';
    if (now.site !== null) {
      return {
        state: 'corpus-only-pending-landed',
        actionable: true,
        headline: "il gemello atteso e' comparso sul sito — pronta la promozione",
        detail:
          `${reason || ''}${tracking} Il fetch su ${entry.sitePath || rel} non risponde piu' 404: verifica che il ` +
          "contenuto sia quello atteso, poi promuovi la voce a `identical`/`adapted` e rigenera la " +
          'baseline con `node scripts/ci/loop-drift-check.mjs --init`.',
      };
    }
    return {
      state: 'corpus-only-pending',
      actionable: true,
      headline: "il sito dovrebbe avere questo file — non ce l'ha ancora",
      detail: `${reason || ''}${tracking}`,
    };
  }

  if (now.site === null) {
    // Il file non è (più) raggiungibile sul sito. Il messaggio DEVE distinguere
    // i due casi, perché la reazione è opposta: se qui il file esiste va deciso
    // se rimuoverlo, se qui non esiste è la voce di manifest a essere stale.
    // Nota: `path` deve puntare a un FILE, mai a una cartella — raw.github
    // risponde 404 per le directory e una voce puntata male atterrerebbe qui
    // travestita da rimozione.
    const hereToo = now.corpus !== null;
    return {
      state: 'removed-on-site',
      actionable: true,
      headline: hereToo ? 'rimosso sul sito, ancora presente qui' : 'assente su entrambi i lati',
      detail: hereToo
        ? 'Il sito non ha piu\' questo file. Va rimosso anche qui, oppure e\' stato spostato e il manifest va aggiornato col nuovo path.'
        : 'Ne\' il sito ne\' questo repo hanno il file: la voce di manifest e\' stale, oppure `path` punta a una CARTELLA invece che a un file (raw.githubusercontent risponde 404 sulle directory). Correggi il path o rimuovi la voce.',
    };
  }

  if (mode === 'not-ported') {
    const moved = now.site !== base.site;
    // A differenza degli altri rami, qui `actionable` NON puo' essere sempre
    // false: `not-ported` e' l'unico mode il cui `baseline.site` puo' restare
    // sbagliato per sempre senza che nessun confronto lo riveli mai (issue
    // #148 — una baseline presa dal ramo di una PR chiusa, mai su `main`). Se
    // il sito e' fermo alla baseline non c'e' niente da decidere; se si e'
    // mosso, la voce deve entrare nel report, perche' e' esattamente li' che
    // una baseline fantasma si nasconderebbe altrimenti in silenzio.
    return {
      state: moved ? 'not-ported-changed' : 'not-ported-stable',
      actionable: moved,
      headline: moved ? 'non portato — ed e\' cambiato sul sito' : 'non portato (deliberato)',
      detail: moved
        ? `${reason || ''} La baseline registrata (\`${base.site}\`) non corrisponde piu' al contenuto attuale sul sito (\`${now.site}\`). Verifica se la policy dichiarata resta valida sul nuovo contenuto; se la baseline non e' mai stata quella giusta (es. presa da un branch mai mergiato), correggila e rilancia \`--init\`.`
        : reason || '',
    };
  }

  if (now.corpus === null) {
    return {
      state: 'missing-here',
      actionable: true,
      headline: 'dichiarato nel manifest ma assente qui',
      detail: 'Il manifest lo elenca come portato, ma il file non esiste. Portalo, o marcalo `not-ported` con una ragione.',
    };
  }

  const siteMoved = now.site !== base.site;
  const corpusMoved = now.corpus !== base.corpus;

  if (!siteMoved && !corpusMoved) {
    // Caso a parte: `identical` che NON e' identico gia' alla baseline. Vuol
    // dire che il manifest e' stato registrato su uno stato gia' divergente.
    if (mode === 'identical' && now.site !== now.corpus) {
      return {
        state: 'undeclared-drift',
        actionable: true,
        headline: 'marcato `identical` ma i due lati differiscono',
        detail: 'Nessuno dei due si e\' mosso dalla baseline, ma gli hash non coincidono: la baseline e\' stata registrata su uno stato gia\' divergente. Riallinea il file, oppure marcalo `adapted` spiegando perche\'.',
      };
    }
    return { state: 'stable', actionable: false, headline: 'allineato', detail: mode === 'adapted' ? reason || '' : '' };
  }

  if (siteMoved && !corpusMoved) {
    return {
      state: 'site-ahead',
      actionable: true,
      headline: 'il sito e\' andato avanti, qui no',
      detail:
        mode === 'adapted'
          ? `Il sito ha modificato un file che qui e\' ADATTATO (${reason || 'ragione non dichiarata'}). Non e\' copiabile: la modifica va letta e riapplicata a mano sopra l'adattamento.`
          : 'Il file e\' dichiarato identico al sito: la modifica del sito e\' copiabile qui cosi\' com\'e\'.',
    };
  }

  if (!siteMoved && corpusMoved) {
    return {
      state: 'corpus-ahead',
      actionable: true,
      headline: 'modificato qui, fermo sul sito',
      detail:
        'Una modifica locale che il sito non ha. Se e\' un adattamento a questo repo, aggiorna la baseline (`--init`) e dichiarala nel manifest. Se e\' un MIGLIORAMENTO del meccanismo, vale la pena proporlo al sito: e\' codice che serve a entrambi i cicli.',
    };
  }

  return {
    state: 'both-moved',
    actionable: true,
    headline: 'modificato su entrambi i lati',
    detail: 'Due modifiche indipendenti sullo stesso file dalla baseline. Nessun allineamento automatico: vanno lette entrambe e riconciliate a mano.',
  };
}

async function main() {
  const manifest = readManifest();
  const results = [];

  for (const entry of manifest.files) {
    const rel = entry.path;
    const sitePath = entry.sitePath || rel;
    const base = entry.baseline || { site: null, corpus: null };

    let now;
    try {
      now = {
        site: entry.mode === 'corpus-only' ? null : await siteHash(sitePath),
        corpus: localHash(rel),
      };
    } catch (e) {
      // Una fetch fallita non deve rendere il report inutile: si segnala il
      // file come non verificato e si va avanti.
      results.push({ path: rel, mode: entry.mode, state: 'check-failed', actionable: false, headline: `verifica fallita: ${String(e.message).slice(0, 80)}`, detail: '' });
      continue;
    }

    if (INIT) {
      // `corpus-only` e `corpus-only-pending` non hanno un sito da tracciare:
      // per il secondo, `now.site` puo' essere non-null (il gemello e' appena
      // atterrato) ma scriverlo qui lo farebbe come effetto collaterale di un
      // `--init` di routine, saltando la verifica del contenuto che il report
      // richiede esplicitamente. La promozione resta un atto cosciente: cambia
      // il `mode` a mano, POI `--init` registra la baseline vera.
      const siteBaseline = (entry.mode === 'corpus-only' || entry.mode === 'corpus-only-pending') ? null : now.site;
      entry.baseline = { site: siteBaseline, corpus: now.corpus, alignedAt: manifest.alignedAt || null };
      continue;
    }

    const verdict = classify(entry, now, base);
    results.push({ path: rel, mode: entry.mode, ...verdict, hashes: { ...now, baseline: base } });
  }

  if (INIT) {
    manifest.alignedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Baseline registrate per ${manifest.files.length} file (alignedAt=${manifest.alignedAt}).`);
    return 0;
  }

  const actionable = results.filter((r) => r.actionable);

  if (AS_JSON) {
    console.log(JSON.stringify({ siteRepo: SITE_REPO, siteRef: SITE_REF, alignedAt: manifest.alignedAt, results, actionable: actionable.length }, null, 2));
  } else {
    const byState = results.reduce((acc, r) => ((acc[r.state] = (acc[r.state] || 0) + 1), acc), {});
    console.log(`Ciclo autonomo — divergenza vs ${SITE_REPO}@${SITE_REF}`);
    console.log(`Baseline dell'ultimo allineamento: ${manifest.alignedAt || '(mai registrata)'}\n`);
    console.log(`${results.length} file sorvegliati — ${Object.entries(byState).map(([k, v]) => `${k}:${v}`).join('  ')}\n`);

    if (!actionable.length) {
      console.log('Niente che richieda una decisione: i due cicli sono allineati, o divergono solo dove dichiarato.');
    } else {
      // Ordine per urgenza decisionale, non alfabetico.
      const ORDER = ['undeclared-drift', 'both-moved', 'site-ahead', 'not-ported-changed', 'corpus-only-pending-landed', 'missing-here', 'removed-on-site', 'corpus-ahead', 'corpus-only-pending'];
      actionable.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
      for (const r of actionable) {
        console.log(`  [${r.state}] ${r.path}`);
        console.log(`      ${r.headline}`);
        if (r.detail) console.log(`      → ${r.detail}`);
        console.log('');
      }
    }
  }

  // Report su issue. Solo quando c'è qualcosa da decidere: una issue aperta a
  // ogni giro per dire "tutto a posto" smette di essere letta, ed è il modo
  // più sicuro per non accorgersi di quella che conta. La deduplica del
  // creator (prefisso del titolo) fa sì che le passate successive commentino
  // sulla stessa issue invece di aprirne una nuova.
  if (AS_ISSUE && actionable.length) {
    const section = (state, title) => {
      const rows = actionable.filter((r) => r.state === state);
      if (!rows.length) return '';
      return [`### ${title}`, '', ...rows.map((r) => `- \`${r.path}\` — ${r.headline}\n  ${r.detail}`), ''].join('\n');
    };
    const description = [
      `Confronto con \`${SITE_REPO}@${SITE_REF}\`, baseline dell'ultimo allineamento: **${manifest.alignedAt || '(mai registrata)'}**.`,
      '',
      `${results.length} file sorvegliati, **${actionable.length}** richiedono una decisione.`,
      '',
      section('undeclared-drift', '🔴 Divergenza non dichiarata'),
      section('both-moved', '🔴 Modificato su entrambi i lati'),
      section('site-ahead', '⬇️ Il sito è andato avanti — da portare qui'),
      section('not-ported-changed', '🔁 Non portato, ma il sito è cambiato — la policy o la baseline vanno riverificate'),
      section('corpus-only-pending-landed', '🟢 Il gemello atteso è arrivato sul sito — pronta la promozione'),
      section('missing-here', '⚠️ Dichiarato nel manifest ma assente'),
      section('removed-on-site', '⚠️ Non più sul sito'),
      section('corpus-ahead', '⬆️ Modificato qui — candidato a risalire al sito'),
      section('corpus-only-pending', '⏳ In attesa del gemello sul sito (lavoro tracciato)'),
      '---',
      '',
      'Le classi `site-ahead` e `corpus-ahead` non sono errori: sono le due direzioni in cui il ciclo evolve. La prima è lavoro da portare, la seconda è un miglioramento locale che probabilmente serve a entrambi i cicli.',
      '',
      '`corpus-only-pending` non è un errore neanche lei: è un promemoria che punta a un lavoro già tracciato altrove (vedi `trackingIssue` in ogni riga). Non richiede un\'azione qui finché non diventa `-landed` — a quel punto la voce va promossa a mano.',
      '',
      'Dopo un allineamento voluto: `node scripts/ci/loop-drift-check.mjs --init` e committa il manifest.',
      '',
      '_Aperta da `scripts/ci/loop-drift-check.mjs`._',
    ].filter(Boolean).join('\n');

    await createGithubIssue({
      title: 'Loop drift: il ciclo autonomo diverge dal sito',
      description,
      priority: 3,
      labels: ['Bug'],
      workflow: 'loop-drift-check',
    });
  }

  return STRICT && actionable.length ? 1 : 0;
}

// Solo in modalita' CLI: senza guardia, importare questo modulo da un test
// eseguirebbe main() — che fa fetch di rete e, con --issue, apre/commenta
// issue sul repo. `classify` resta importabile per testare la classificazione
// senza pagare nessuno dei due.
if (process.argv[1] && process.argv[1].endsWith('loop-drift-check.mjs')) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      // PROCEED-SAFE: un checker rotto non deve rompere la CI di nessuno.
      console.error(`loop-drift-check fallito: ${e && e.stack ? e.stack : e}`);
      process.exit(STRICT ? 1 : 0);
    },
  );
}

export { classify, sha256 };
