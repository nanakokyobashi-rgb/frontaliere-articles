/**
 * classify-issue.mjs — Classificazione deterministica delle issue per issue-triage.yml.
 *
 * ADATTAMENTO DICHIARATO (manifest: `classify-issue`). La superficie del modulo
 * e la CLI sono identiche a quelle del sito — `classifyIssue(title, labels)` →
 * `{category, autofix, route, fuPrio}` — così `triage-sweep.mjs` e lo YAML del
 * triage restano copiabili senza modifiche. Cambiano SOLO le categorie, perché
 * i due repo si rompono in modi diversi: il sito ha crawler e RPM, qui c'è una
 * superficie dati pubblicata e un corpus generato.
 *
 * ## Le categorie, e perché una sola salta la coda
 *
 *   publish   → `route: 'fix'` — l'UNICA immediata. Se `publish-api` non
 *               ripubblica, il sito continua a servire la superficie VECCHIA
 *               senza che niente fallisca: nessun errore, solo dati fermi. È
 *               già successo — un feed RSS rimasto fermo tre mesi. Volume
 *               basso (1 fallimento in 7 giorni misurati), quindi il route
 *               diretto non rischia di intasare lo slot del fixer.
 *
 *   engine    → coda, priorità alta. Il contratto `engine/` ↔ `host/` si rompe
 *               a render time DIETRO una CI verde: `node --test` non importa
 *               TypeScript e legge l'engine come testo. Alta priorità perché
 *               invisibile, non perché urgente.
 *
 *   generation→ coda, priorità bassa. È il grosso del volume (misurato: 9
 *               `Generate Blog Article` + 8 `fast-publish-article` su 18
 *               fallimenti in 7 giorni) e dipende da provider LLM e rete:
 *               transiente per natura. Metterlo in coda bassa è ciò che
 *               impedisce al rumore di generazione di affamare tutto il resto.
 *
 *   ci        → coda. Un `tests` rosso su una PR è già gestito dal ciclo PR;
 *               qui arrivano solo i fallimenti su main.
 *
 *   follow-up → coda, come sul sito.
 *
 * `route: 'queue'` non è un declassamento: è l'anti-starvation. Le issue in
 * coda vengono promosse UNA alla volta dal drainer, solo a slot del fixer
 * libero, quindi non muoiono cancellate in coda. Sul sito, estendere l'autofix
 * a tutte le categorie SENZA questo meccanismo aveva prodotto il 60% di run
 * cancellate e una ventina di issue bloccate.
 *
 * Uso modulo:
 *   import { classifyIssue } from './classify-issue.mjs';
 * Uso CLI:
 *   node scripts/lib/classify-issue.mjs "<title>" '<labels-json-array>'
 */

export function classifyIssue(title = '', labels = []) {
  const set = new Set((labels || []).map((s) => String(s).toLowerCase()));
  const has = (name) => set.has(String(name).toLowerCase());
  const t = (re) => re.test(title || '');

  let category = 'other';

  // Ordine conservativo: le categorie più specifiche per prime. `publish` apre
  // la lista perché è l'unica che salta la coda, quindi non deve mai essere
  // catturata da una regex più generica a valle.
  if (
    t(/publish-api|Publish article data API|build-api|cf-purge|CDN|R2\b/i) ||
    has('publish-broken')
  ) {
    category = 'publish';
  } else if (t(/engine|siteShell|SiteShellContract|lockstep|host\//i) || has('engine-contract')) {
    category = 'engine';
  } else if (t(/Generate Blog Article|fast-publish|journalist|batch-faq|events-digest|border-wait/i)) {
    category = 'generation';
  } else if (t(/^Workflow Failure: tests|Generator CI|CI Failure/i)) {
    category = 'ci';
  } else if (t(/^follow-up\(#/i) || has('follow-up')) {
    category = 'follow-up';
  } else if (t(/Loop drift/i)) {
    category = 'loop-drift';
  }

  // Come sul sito: nessuna categoria è human-only. Le safety-valve del fixer
  // (root-cause non determinabile, capability-guard su workflows/secret) sono
  // generiche e restano — non sono guardrail di categoria.
  const autofix = true;
  const route = category === 'publish' ? 'fix' : 'queue';
  const fuPrio =
    route === 'queue'
      ? has('priority:high') ||
        has('priority:urgent') ||
        category === 'engine' ||
        category === 'ci'
        ? 'high'
        : 'low'
      : null;

  return { category, autofix, route, fuPrio };
}

// CLI mode
if (process.argv[1] && process.argv[1].endsWith('classify-issue.mjs')) {
  const title = process.argv[2] || '';
  let labels = [];
  try {
    labels = JSON.parse(process.argv[3] || '[]');
    if (!Array.isArray(labels)) labels = [];
  } catch {
    labels = [];
  }
  process.stdout.write(JSON.stringify(classifyIssue(title, labels)));
}
