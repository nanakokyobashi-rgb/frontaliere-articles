#!/usr/bin/env node
/**
 * repair-source-echo.mjs — toglie dai corpi pubblicati l'eco della pagina
 * sorgente. Issue #202.
 *
 * ## Che cosa ripara, e che cosa NON ripara
 *
 * L'estrattore consegnava al modello l'intera pagina scrapata invece della sola
 * radice editoriale, e la REGOLA #1 del prompt («ogni fatto DEVE essere
 * presente nel SOURCE CONTENT») lo rendeva fedele anche a cio' che non doveva
 * ricevere. La causa e' rimossa a monte (`isolateMainSourceHtml()` in
 * create-article.mjs); questo script rimuove cio' che e' gia' stato pubblicato.
 *
 * Ripara DUE classi, entrambe meccaniche:
 *
 *  1. CODA DI CHROME. Su una pagina di articolo il mobilio della testata sta
 *     DOPO il pezzo: titolo-civetta di un altro articolo, firma di redazione,
 *     invito a registrarsi, regolamento dei commenti, spalla «ultimi commenti».
 *     Quando un marcatore di chrome compare nell'ultimo terzo di un campo,
 *     tutto cio' che segue appartiene alla pagina, non all'articolo: si taglia
 *     da li' alla fine. Nel caso `ristorni-frontalieri-berna` sono i 1.961
 *     caratteri che la issue misura.
 *
 *  2. RIFERIMENTO ALLA REDAZIONE DELLA FONTE. Frasi e proposizioni in cui
 *     l'articolo indica la redazione della testata sorgente come se fosse la
 *     nostra («contattando direttamente la redazione di VareseNews»). Non e'
 *     eco letterale, e' il modello che ha assorbito il contesto della pagina —
 *     ma il difetto e' lo stesso e la rimozione e' altrettanto meccanica: la
 *     proposizione coordinata si stacca lasciando la frase intera.
 *
 * ## Perche' un elenco di stringhe FISSATE e non un'euristica
 *
 * Una riparazione euristica sui corpi ha gia' fabbricato danni in questo repo
 * (il detector di lingua sbagliava il 33% e poi «riparava» dal tedesco). Qui
 * ogni sostituzione e' un pin: file, testo esatto, motivo. Se il testo non c'e'
 * lo script lo DICE invece di cercarne uno simile, e se non c'e' piu' nulla da
 * fare esce pulito — e' idempotente.
 *
 * Uso:
 *   node generator/scripts/repair-source-echo.mjs            # dry-run
 *   node generator/scripts/repair-source-echo.mjs --apply    # scrive
 *   node generator/scripts/repair-source-echo.mjs --verify   # scansione corpus
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const RISTORNI = 'ristorni-frontalieri-berna-deplora-lo-stop-del-cantone-ma-vuole-una-soluzione.ts';
const FESTIVAL = 'festival-meraviglia-laveno-luino-2026.ts';
const EX_SEDE = 'ex-sede-banca-ditalia-vendita-varese.ts';

const body = (locale, file) => path.join('content', 'blog-body', locale, file);

/**
 * `cutTail`  — dal marcatore alla fine del campo (il campo e' una riga sola).
 * `remove`   — cancellazione esatta, ripetuta su tutte le occorrenze.
 */
const PINS = [
  // ── 1. Coda di chrome ────────────────────────────────────────────────────
  {
    kind: 'cutTail', file: body('it', RISTORNI), marker: '\\n\\nRistorni bloccati, Alfieri:',
    why: 'titolo-civetta + firma di redazione + invito a commentare + regolamento + spalla «ultimi commenti» (1.961 char, 27% del corpo)',
  },
  {
    kind: 'cutTail', file: body('en', RISTORNI), marker: ' Rebates blocked, Alfieri:',
    why: 'stessa coda, tradotta: nella versione en i blocchi arrivano senza interruzione di paragrafo',
  },
  {
    kind: 'cutTail', file: body('it', FESTIVAL), marker: '\\n\\nTutti gli eventi di maggio a Materia',
    why: 'riga di contatto della redazione sorgente in fondo alla pagina (indirizzo + email)',
  },
  {
    kind: 'cutTail', file: body('en', FESTIVAL), marker: '\\n\\nAll events in May at Materia',
    why: 'idem, en',
  },
  {
    kind: 'cutTail', file: body('de', FESTIVAL), marker: '\\n\\nAlle Veranstaltungen im Mai in Materia',
    why: 'idem, de',
  },
  {
    kind: 'cutTail', file: body('fr', FESTIVAL), marker: '\\n\\nTous les événements de mai à Materia',
    why: 'idem, fr',
  },

  // ── 2. Riferimenti alla redazione della fonte ────────────────────────────
  // Frasi intere: cio' che resta e' il paragrafo senza di esse, gia' compiuto.
  {
    kind: 'remove', file: body('it', EX_SEDE),
    text: " La redazione di VareseNews si è occupata di questo caso, cercando di capire il motivo della difficoltà di vendita.",
    why: 'la frase parla di cosa ha fatto la testata sorgente, non dell’immobile',
  },
  {
    kind: 'remove', file: body('en', EX_SEDE),
    text: " The editorial staff of VareseNews has dealt with this case, trying to understand the reason for the difficulty in selling.",
    why: 'idem, en',
  },
  {
    kind: 'remove', file: body('de', EX_SEDE),
    text: " Die Redaktion von VareseNews hat sich mit diesem Fall beschäftigt und versucht, die Gründe für die Schwierigkeiten beim Verkauf zu verstehen.",
    why: 'idem, de',
  },
  {
    kind: 'remove', file: body('fr', EX_SEDE),
    text: " La rédaction de VareseNews s\\'est occupée de ce cas, cherchant à comprendre la raison de la difficulté de vente.",
    why: 'idem, fr (l’apostrofo e’ escapato nel sorgente TS)',
  },

  // Proposizioni coordinate: si stacca la coordinata, la principale resta
  // intera e continua a dire come si prenotano i biglietti.
  {
    kind: 'remove', file: body('it', FESTIVAL), text: ' o contattando direttamente la redazione di VareseNews',
    why: 'la redazione della fonte indicata come canale di prenotazione; resta «attraverso il sito ufficiale del festival»',
  },
  { kind: 'remove', file: body('it', FESTIVAL), text: ' o contatta la redazione di VareseNews', why: 'idem, imperativo' },
  {
    kind: 'remove', file: body('en', FESTIVAL), text: ' or by contacting the VareseNews editorial team directly',
    why: 'idem, en',
  },
  { kind: 'remove', file: body('en', FESTIVAL), text: ' or contact the VareseNews editorial team', why: 'idem, en imperativo' },
  {
    kind: 'remove', file: body('de', FESTIVAL), text: ' oder durch direkte Kontaktaufnahme mit der Redaktion von VareseNews',
    why: 'idem, de',
  },
  { kind: 'remove', file: body('de', FESTIVAL), text: ' oder kontaktieren Sie die Redaktion von VareseNews', why: 'idem, de imperativo' },
  { kind: 'remove', file: body('de', FESTIVAL), text: ' oder direkt die Redaktion von VareseNews kontaktieren', why: 'idem, de (FAQ)' },
  {
    kind: 'remove', file: body('fr', FESTIVAL), text: ' ou en contactant directement la rédaction de VareseNews',
    why: 'idem, fr',
  },
  { kind: 'remove', file: body('fr', FESTIVAL), text: ' ou contactez la rédaction de VareseNews', why: 'idem, fr imperativo' },
];

/**
 * Marcatori di mobilio della pagina sorgente. Sono la definizione operativa di
 * «eco della fonte» usata sia da --verify sia da
 * generator/tests/article-source-echo.test.mjs: cambiarli qui li cambia in
 * entrambi i posti solo se il test li rilegge da questo file — cosa che fa.
 */
export const SOURCE_ECHO_MARKERS = [
  // Firma / pitch della redazione della testata sorgente
  'redazione di VareseNews',
  'Redazione VareseNews',
  'Redaktion von VareseNews',
  'rédaction de VareseNews',
  'editorial staff of VareseNews',
  'VareseNews editorial staff',
  'VareseNews editorial team',
  // Modulo e regolamento dei commenti
  'Accedi o registrati per commentare',
  'Log in or register to comment',
  'linea editoriale di VareseNews',
  'editorial line of VareseNews',
  // Recapito di redazione finito nel corpo
  'redazione@varesenews.it',
];

function cutTail(src, marker) {
  const at = src.indexOf(marker);
  if (at === -1) return { src, changed: 0 };
  // Il campo e' una riga: la fine del valore e' la chiusura `',` di quella riga.
  const lineEnd = src.indexOf('\n', at);
  const line = src.slice(at, lineEnd === -1 ? src.length : lineEnd);
  const closeRel = line.lastIndexOf("',");
  if (closeRel === -1) throw new Error(`chiusura del campo non trovata dopo il marcatore: ${marker}`);
  return { src: src.slice(0, at) + src.slice(at + closeRel), changed: 1 };
}

function removeAll(src, text) {
  let changed = 0;
  let out = src;
  while (out.includes(text)) {
    out = out.replace(text, '');
    changed += 1;
    if (changed > 20) throw new Error(`troppe occorrenze rimosse, pin sospetto: ${text}`);
  }
  return { src: out, changed };
}

function listBodyFiles() {
  const out = [];
  for (const dir of ['blog-body', 'blog-body-ch']) {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const full = path.join(ROOT, 'content', dir, locale);
      if (!fs.existsSync(full)) continue;
      for (const f of fs.readdirSync(full)) {
        if (f.endsWith('.ts')) out.push(path.join('content', dir, locale, f));
      }
    }
  }
  return out;
}

export function scanCorpusForSourceEcho(root = ROOT) {
  const offenders = [];
  for (const rel of listBodyFiles()) {
    const src = fs.readFileSync(path.join(root, rel), 'utf-8');
    const hits = SOURCE_ECHO_MARKERS.filter((m) => src.includes(m));
    if (hits.length > 0) offenders.push({ file: rel, markers: hits });
  }
  return offenders;
}

function main() {
  const apply = process.argv.includes('--apply');
  const verifyOnly = process.argv.includes('--verify');

  if (!verifyOnly) {
    const byFile = new Map();
    for (const pin of PINS) {
      if (!byFile.has(pin.file)) {
        const full = path.join(ROOT, pin.file);
        if (!fs.existsSync(full)) {
          console.error(`⚠️  file assente, pin saltato: ${pin.file}`);
          continue;
        }
        byFile.set(pin.file, fs.readFileSync(full, 'utf-8'));
      }
      const before = byFile.get(pin.file);
      if (before === undefined) continue;
      const res = pin.kind === 'cutTail' ? cutTail(before, pin.marker) : removeAll(before, pin.text);
      if (res.changed === 0) {
        console.error(`   ∅ ${pin.file}: gia’ pulito — ${pin.kind} «${(pin.marker || pin.text).slice(0, 60)}…»`);
      } else {
        console.error(`   ✂️  ${pin.file}: ${res.changed}× ${pin.kind} — ${pin.why}`);
      }
      byFile.set(pin.file, res.src);
    }

    let written = 0;
    for (const [rel, next] of byFile) {
      const full = path.join(ROOT, rel);
      const current = fs.readFileSync(full, 'utf-8');
      if (current === next) continue;
      written += 1;
      const delta = current.length - next.length;
      console.error(`   ${apply ? '💾' : '👀'} ${rel}: −${delta} caratteri`);
      if (apply) fs.writeFileSync(full, next);
    }
    console.error(`\n${apply ? 'Scritti' : 'Da scrivere'}: ${written} file`);
  }

  const offenders = scanCorpusForSourceEcho();
  if (offenders.length === 0) {
    console.error('✅ Nessun marcatore di eco della fonte nel corpus.');
    return;
  }
  console.error(`\n⚠ RESIDUI: ${offenders.length} file portano ancora marcatori di eco della fonte:`);
  for (const o of offenders) console.error(`   ${o.file} → ${o.markers.join(', ')}`);
  process.exitCode = verifyOnly ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
