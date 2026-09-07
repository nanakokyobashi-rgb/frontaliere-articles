/**
 * ── ENUMERARE LE LETTURE DI `process.env` IN UN SORGENTE ───────────────────
 *
 * Due gate di questo repo rispondono alla domanda «quali variabili d'ambiente
 * legge questo modulo?» leggendone il TESTO: la tabella
 * `PER_MACHINE_ENDPOINT_ENV` di `ai-models.mjs` (assert in
 * `ai-models-ledger-gate.test.mjs`) e `CONTRACT_ENV_KEYS` di `host/`
 * (`shell-contract-env-normalized.test.mjs`). Entrambi cercavano la sola
 * lettura LETTERALE con accesso a punto, cioe' `process.env.NOME`.
 *
 * Il difetto (#1046) e' che quella non e' l'unica forma di lettura, e le altre
 * lasciano la tabella corta **col verde addosso** — che e' esattamente il modo
 * di fallire che i due gate esistono per chiudere:
 *
 *   const { OMNIROUTE_URL } = process.env;   // destrutturazione: invisibile
 *   process.env['OMNIROUTE_URL']            // indicizzazione: invisibile a uno dei due
 *   process.env[cfg.urlEnv]                 // chiave dinamica: non risolvibile
 *   const env = process.env;                 // alias: l'oggetto intero sfugge
 *
 * Le prime due sono statiche e vanno semplicemente RICONOSCIUTE. Le ultime due
 * non sono risolvibili leggendo il testo, e per loro l'unica risposta onesta e'
 * il rumore: finiscono in `opaque`, e il gate chiamante le fa fallire finche'
 * qualcuno non le dichiara sicure sulla riga stessa con
 * `// env-scan: <motivo>`. Ignorarle in silenzio e' cio' che faceva prima.
 *
 * L'esenzione vive sulla RIGA della lettura, non in una lista altrove, per due
 * ragioni: sopravvive allo spostamento del codice, e (nel caso di
 * `ai-models.mjs`) un commento su riga propria verrebbe svuotato dal filtro dei
 * commenti prima ancora di arrivare qui.
 */

/** Il marcatore che dichiara sicura una lettura non risolvibile staticamente. */
export const ENV_SCAN_EXEMPTION_RE = /env-scan:\s*\S/;

/**
 * Svuota le righe che sono SOLO commento, lasciando i numeri di riga intatti.
 *
 * Serve ai sorgenti che citano il proprio codice in prosa: un
 * `process.env.NUOVO_PROVIDER_URL` dentro un docblock non e' una lettura. Il
 * filtro e' per riga e non a blocchi di proposito — un `/*` dentro un commento
 * `//` aprirebbe un finto blocco e il primo `*` seguito da `/` si porterebbe via
 * il codice in mezzo (misurato: 4.732 righe su 7.535 di `ai-models.mjs`).
 */
export function stripCommentLines(src) {
  return src
    .split('\n')
    .map((riga) => (/^\s*(\/\/|\/\*|\*)/.test(riga) ? '' : riga))
    .join('\n');
}

/**
 * @typedef {object} EnvReadScan
 * @property {Set<string>} names   nomi risolti staticamente
 * @property {{name: string, line: number}[]} reads  ogni lettura risolta
 * @property {{line: number, form: string, text: string}[]} opaque
 *   letture che il testo non basta a risolvere e che nessuno ha dichiarato
 */

/**
 * @param {string} src sorgente JS/TS
 * @returns {EnvReadScan}
 */
export function scanEnvReads(src) {
  const righe = src.split('\n');
  // Indice di inizio di ogni riga, per tradurre un offset in numero di riga.
  const inizi = [];
  let acc = 0;
  for (const riga of righe) { inizi.push(acc); acc += riga.length + 1; }
  const lineAt = (index) => {
    let lo = 0;
    let hi = inizi.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (inizi[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const names = new Set();
  const reads = [];
  const opaque = [];
  const add = (name, index) => { names.add(name); reads.push({ name, line: lineAt(index) }); };
  const opaco = (form, index) => {
    const line = lineAt(index);
    if (ENV_SCAN_EXEMPTION_RE.test(righe[line - 1] ?? '')) return;
    opaque.push({ line, form, text: (righe[line - 1] ?? '').trim() });
  };

  // 1. `process.env.NOME`
  for (const m of src.matchAll(/process\.env\.([A-Za-z_$][\w$]*)/g)) add(m[1], m.index);

  // 2/3. `process.env[...]`: letterale → risolta, tutto il resto → opaca.
  //      Un template SENZA sostituzioni e' un letterale a tutti gli effetti;
  //      con `${...}` dentro non lo e' piu' (`GH_MODELS_PAT_${i}`).
  for (const m of src.matchAll(/process\.env\s*\[/g)) {
    const resto = src.slice(m.index + m[0].length);
    const lit = resto.match(/^\s*(?:'([^'\n]*)'|"([^"\n]*)"|`([^`$\\\n]*)`)\s*\]/);
    if (lit) add(lit[1] ?? lit[2] ?? lit[3], m.index);
    else opaco('chiave dinamica', m.index);
  }

  // 4. `const { A, B: c } = process.env` — anche su piu' righe.
  for (const m of src.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
    for (const pezzo of m[1].split(',')) {
      const t = pezzo.trim();
      if (!t) continue;
      if (t.startsWith('...')) { opaco('rest di process.env', m.index); continue; }
      if (t.startsWith('[')) { opaco('chiave calcolata in destrutturazione', m.index); continue; }
      const k = t.match(/^([A-Za-z_$][\w$]*)/);
      if (k) add(k[1], m.index);
      else opaco('destrutturazione non riconosciuta', m.index);
    }
  }

  // 5. `const env = process.env` — l'oggetto intero sfugge all'enumerazione.
  //    Escluso l'accesso, dove `process.env` e' solo il prefisso di una lettura
  //    gia' contata ai punti 1-2.
  for (const m of src.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=\s*process\.env\s*(?![.[])/g)) {
    opaco(`alias \`${m[1]}\` dell'intero process.env`, m.index);
  }

  return { names, reads, opaque };
}

/** Riga leggibile per i messaggi d'errore dei gate chiamanti. */
export function describeOpaqueRead({ line, form, text }) {
  return `${line}: ${text}  [${form}]`;
}
