#!/usr/bin/env node
/**
 * transport-identical-twins.mjs — il trasporto che ai gemelli `identical` del
 * manifest mancava (issue #331, follow-up di #326 e #303).
 *
 * ## Il buco che chiude
 *
 * `loop-drift-check.mjs` sa dire che un gemello `identical` è fermo indietro, e
 * da quanto (`stranded-twin`, issue #303). Non lo porta: «non mergia, non apre
 * PR, non riscrive niente». Per ognuna delle voci `identical` del manifest la
 * discesa era quindi **una copia a mano**, e il 2026-08-14 cinque gemelli erano
 * fermi fino a 15,75 giorni — fra questi `host/shared/localeEmitFilter.ts`, che
 * sul sito aveva già prodotto `/en.html` `/de.html` `/fr.html` a 404 (#5327) e
 * qui girava ancora col difetto. Il verdetto rende il ritardo visibile e datato;
 * non lo elimina.
 *
 * ## Perché QUI, e non allargando l'allowlist del mirror
 *
 * L'altra strada — estendere l'allowlist di `mirror-articles-engine.yml` (che
 * gira sul SITO) oltre `engine/` — è bloccata, e per una ragione che non scade:
 * quell'allowlist copia **directory intere**, e sotto `scripts/**`/`host/**`
 * vivono decine di file `adapted`, diversi apposta (es.
 * `scripts/ci/auto-merge-eval.mjs`, che qui ha un gate in più e sul sito
 * un'osservazione che qui non esiste). Sovrascriverli sarebbe la metà
 * distruttiva del vecchio mirror, spostata da `content/` a `generator/`. Da qui
 * la richiesta di una «prova di confinamento» equivalente a
 * `packages-articles-confinement.test.ts` prima di allargare.
 *
 * Questo script prende la direzione opposta e non ha bisogno di quella prova:
 *
 *   - **è tirato, non spinto**: gira in questo repo, che è il lato che RICEVE;
 *   - **è guidato dal manifest, file per file**: copia solo i path dichiarati
 *     `mode: "identical"`, dal loro `sitePath`. Un file `adapted` non è
 *     "protetto da un'eccezione" — non è proprio nell'insieme di partenza, e
 *     nessuna directory viene mai copiata in blocco. Il confinamento che la
 *     prova AST dimostrerebbe per un albero, qui è l'enumerazione stessa;
 *   - **copia solo `site-ahead`**: il verdetto arriva da `classify()` di
 *     `loop-drift-check.mjs`, importata, non reimplementata. Se questo lato si
 *     è mosso (`corpus-ahead`, `both-moved`, `undeclared-drift`) non si tocca
 *     niente: una divergenza a due direzioni è una decisione, e questo script
 *     non ha il contesto per prenderla — esattamente come il drift check.
 *
 * `engine/` resta fuori: è `outOfScope` nel manifest PROPRIO perché un
 * trasporto ce l'ha già (il mirror), e due canali sullo stesso path sono un
 * conflitto, non una ridondanza.
 *
 * ## Cosa NON fa
 *
 * Non mergia e non decide: scrive i file e aggiorna la baseline delle sole voci
 * copiate. La PR la apre il workflow, e passa dalla review come ogni altra.
 * Senza `--apply` non scrive niente: la modalità di default è il dry-run.
 *
 * ## Uso
 *
 *   node scripts/ci/transport-identical-twins.mjs            # dry-run, report
 *   node scripts/ci/transport-identical-twins.mjs --json     # dry-run, JSON
 *   node scripts/ci/transport-identical-twins.mjs --apply    # scrive + baseline
 *
 * Env:
 *   SITE_REPO / SITE_REF   letti da `loop-drift-check.mjs` (stessa sorgente).
 *   GH_TOKEN               opzionale; il repo del sito è pubblico.
 *   TRANSPORT_MAX_FILES    default 25; tetto di file copiati in una passata.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classify, siteFile } from './loop-drift-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');

const ARGS = new Set(process.argv.slice(2));
const APPLY = ARGS.has('--apply');
const AS_JSON = ARGS.has('--json');

/**
 * Tetto per passata. Non è una difesa dai file: è una difesa dal GIORNO in cui
 * il sito rinomina mezzo albero e questo script aprirebbe una PR da 100 file
 * che nessuno rivede davvero. Oltre il tetto la passata si ferma e lo dice,
 * così la copia resta un atto leggibile.
 */
const MAX_FILES = Number(process.env.TRANSPORT_MAX_FILES || 25);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/**
 * Un path del manifest è un dato, e un dato che diventa una destinazione di
 * scrittura va trattato come non fidato: `..`, path assoluto o separatore
 * Windows farebbero uscire la copia dal checkout. È l'unico punto dello script
 * che scrive, quindi è l'unico punto dove serve.
 *
 * `.github/workflows/` è escluso a parte, e non per la sicurezza del path: il
 * token del ciclo non ha lo scope `workflows`, quindi una copia lì produrrebbe
 * un push RIFIUTATO dopo aver scritto il file — cioè una passata che fallisce
 * in fondo invece che all'inizio. Quei 20 gemelli restano una copia a mano.
 */
export function unsafeTarget(rel) {
  if (typeof rel !== 'string' || rel.trim() === '') return 'path vuoto';
  if (rel.includes('\\')) return 'separatore non POSIX';
  if (path.posix.isAbsolute(rel) || path.isAbsolute(rel)) return 'path assoluto';
  if (rel.split('/').includes('..')) return 'path risalente';
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return 'destinazione fuori dal checkout';
  if (rel.startsWith('.github/workflows/')) return 'workflow: il token del ciclo non ha lo scope `workflows`';
  return null;
}

/**
 * Decide se UNA voce va copiata giù dal sito. Pura: prende gli hash già
 * calcolati, come `classify()` — è questo a renderla testabile offline, senza
 * rete e senza scrivere niente.
 *
 *   entry            la voce di manifest (`path`, `mode`, `sitePath`, `baseline`).
 *   now              { site, corpus } gli hash di ORA, `null` se assente.
 *   base             la baseline registrata ({ site, corpus }).
 *   outOfScopePrefixes  i prefissi `scope.outOfScope` del manifest.
 *
 * Ritorna `{ transport, state, reason }`. `transport: true` SOLO per un
 * `identical` in `site-ahead` con una destinazione scrivibile: ogni altro
 * verdetto è un no con la sua ragione, mai un silenzio.
 */
export function transportVerdict(entry, now, base, { outOfScopePrefixes = [] } = {}) {
  const state = classify(entry, now, base).state;
  if (entry.mode !== 'identical') {
    return { transport: false, state, reason: `mode \`${entry.mode}\`: solo \`identical\` è copiabile così com'è` };
  }
  // Difesa in profondità: una voce `identical` sotto un prefisso `outOfScope`
  // non dovrebbe esistere (i due insiemi sono disgiunti per costruzione), ma se
  // ci finisse avrebbe DUE trasporti sullo stesso path — il mirror e questo.
  const covered = outOfScopePrefixes.find((p) => entry.path.startsWith(p));
  if (covered) {
    return { transport: false, state, reason: `\`${covered}\` è outOfScope: ha già un trasporto suo, due canali sullo stesso path sono un conflitto` };
  }
  const unsafe = unsafeTarget(entry.path);
  if (unsafe) return { transport: false, state, reason: `destinazione non scrivibile (${unsafe})` };
  if (state !== 'site-ahead') {
    return { transport: false, state, reason: `stato \`${state}\`: copiabile solo \`site-ahead\` (il sito avanti, questo lato fermo sulla baseline)` };
  }
  return { transport: true, state, reason: 'il sito è andato avanti e qui nessuno ha toccato il file: la copia è esatta' };
}

/** Hash del file locale, o null se non esiste. */
function localHash(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const outOfScopePrefixes = (manifest.scope?.outOfScope || []).map((x) => x.prefix);
  const today = new Date().toISOString().slice(0, 10);

  const transported = [];
  const skipped = [];
  const failed = [];
  let capped = 0;

  for (const entry of manifest.files) {
    if (entry.mode !== 'identical') continue;
    const rel = entry.path;
    const sitePath = entry.sitePath || rel;
    const base = entry.baseline || { site: null, corpus: null };

    let content;
    let now;
    try {
      content = await siteFile(sitePath);
      now = { site: content === null ? null : sha256(content), corpus: localHash(rel) };
    } catch (e) {
      // PROCEED-SAFE come il drift check: una fetch fallita non deve far
      // saltare le altre copie, e soprattutto non deve MAI valere come "il
      // file non c'è più sul sito" (che sarebbe una rimozione inventata).
      failed.push({ path: rel, reason: String(e.message || e).slice(0, 120) });
      continue;
    }

    const verdict = transportVerdict(entry, now, base, { outOfScopePrefixes });
    if (!verdict.transport) {
      skipped.push({ path: rel, state: verdict.state, reason: verdict.reason });
      continue;
    }
    if (transported.length >= MAX_FILES) {
      capped += 1;
      continue;
    }

    if (APPLY) {
      const abs = path.join(ROOT, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      // Dopo la copia i due lati sono lo STESSO byte: la baseline è quell'hash
      // su entrambi i lati. Scriverla qui è ciò che impedisce al prossimo giro
      // di drift check di rileggere la copia appena fatta come una divergenza.
      entry.baseline = { site: now.site, corpus: now.site, alignedAt: today };
    }
    transported.push({ path: rel, sitePath, from: base.site, to: now.site });
  }

  if (APPLY && transported.length) {
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ apply: APPLY, transported, capped, failed, skipped }, null, 2));
  } else {
    const mode = APPLY ? 'APPLY' : 'dry-run';
    console.log(`transport-identical-twins (${mode}): ${transported.length} da portare, ${skipped.length} fermi, ${failed.length} non verificati`);
    for (const t of transported) console.log(`  ⬇ ${t.path}  ←  ${t.sitePath}  (${t.from} → ${t.to})`);
    if (capped) console.log(`  ⏸ altri ${capped} oltre il tetto di ${MAX_FILES} file: restano al prossimo giro`);
    for (const f of failed) console.log(`  ⚠ ${f.path}: ${f.reason}`);
    // Gli skip attivi — quelli che una persona deve guardare — sono i soli
    // stampati: elencare 150 `stable` ogni giorno è la riga che nessuno legge.
    for (const s of skipped.filter((x) => x.state !== 'stable')) console.log(`  · ${s.path}: ${s.reason}`);
  }

  // Sempre 0: un trasporto che non trova niente da portare non è un
  // fallimento, ed è il caso NORMALE. Chi chiama guarda il diff.
  return 0;
}

// Solo in modalita' CLI: senza guardia, importare questo modulo da un test
// farebbe rete e, con --apply, scriverebbe sull'albero.
if (process.argv[1] && process.argv[1].endsWith('transport-identical-twins.mjs')) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`transport-identical-twins fallito: ${e && e.stack ? e.stack : e}`);
      process.exit(1);
    },
  );
}
