/**
 * workflow-steps.mjs — enumerazione degli step di un workflow, ciechi inclusi.
 *
 * ## Perche' esiste (#935 item 1)
 *
 * Mezza dozzina di test inchiodano l'ORDINE o la COPERTURA degli step di un
 * workflow spezzando il testo su `/^ {6}- name: /`. Uno step nella forma senza
 * nome — `      - uses: actions/upload-artifact@v4`, e nei workflow di questo
 * repo ce ne sono decine — non entra nell'enumerazione: per
 * `daily-brief-degradation-alarm.test.mjs` l'ultimo step resta il gate anche se
 * il gate non e' piu' ultimo, e il test **resta verde sulla regressione esatta
 * che esiste per fermare** (l'`exit 1` del gate salterebbe lo step aggiunto
 * dopo, e nessuna run successiva ripara: il push CDN lavora sull'id del giorno
 * corrente).
 *
 * Stessa forma per lo slicing «da questo `- name:` al prossimo»: uno step senza
 * nome infilato in mezzo finisce assorbito nel testo del precedente, dove una
 * `assert.match` lo legge come se fosse suo.
 *
 * ## Come riconosce uno step
 *
 * Testo grezzo e non YAML parsato: `node --test` gira senza dipendenze su
 * questo repo (AGENTS.md, «Build e test»). Il confine e' contestuale, non
 * lessicale: si entra su `^ {4}steps:` e si esce al primo rientro sotto i sei
 * spazi. E' cio' che tiene fuori le liste a sei spazi che step non sono — le
 * voci di `on.push.paths`, che sono `- '...'` e non `- <chiave>:`.
 */

const STEPS_KEY_RE = /^ {4}steps:\s*(#.*)?$/;
const STEP_ITEM_RE = /^ {6}- (?:([A-Za-z][\w.-]*):[ \t]?(.*))?$/;
const STEP_NAME_RE = /^ {8}name:[ \t]*(.+?)\s*$/;

/**
 * Il valore YAML di uno scalare in linea: apici via, e per uno scalare piano il
 * commento di fine riga pure — ` #` lo apre davvero, quindi
 * `name: Alert (... per #293)` in `publish-api.yml` VALE troncato a `per`.
 */
const scalar = (value) => {
  const v = value.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.endsWith(q) && v.length > 1) return v.slice(1, -1);
  return v.replace(/\s+#.*$/, '').trim();
};

/**
 * Gli step di tutti i job del workflow, in ordine di apparizione.
 *
 * @param {string} yml sorgente del workflow
 * @returns {{name: string, key: string|null, named: boolean, at: number, end: number, text: string}[]}
 *   `name` e' il `name:` dichiarato; per uno step senza nome e' l'etichetta
 *   della sua prima chiave (`uses: actions/checkout@v5`), cosi' un messaggio di
 *   assert resta leggibile invece di dire `undefined`. `named` distingue i due
 *   casi, `at`/`end`/`text` sono gli estremi del blocco.
 */
export function workflowSteps(yml) {
  const steps = [];
  let current = null;
  let inSteps = false;
  let offset = 0;

  const close = (endAt) => {
    if (!current) return;
    current.end = endAt;
    current.text = yml.slice(current.at, endAt);
    current.name = current.declaredName ?? current.label;
    current.named = current.declaredName !== null;
    delete current.declaredName;
    delete current.label;
    steps.push(current);
    current = null;
  };

  for (const line of yml.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;

    if (STEPS_KEY_RE.test(line)) {
      close(lineStart);
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;

    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (line.length - line.trimStart().length < 6) {
      close(lineStart);
      inSteps = false;
      continue;
    }

    const item = STEP_ITEM_RE.exec(line);
    if (item) {
      close(lineStart);
      const [, key, value] = item;
      current = {
        at: lineStart,
        end: yml.length,
        text: '',
        key: key ?? null,
        name: '',
        named: false,
        declaredName: key === 'name' ? scalar(value ?? '') : null,
        label: key ? `${key}: ${scalar(value ?? '')}`.trim() : '<step senza chiavi in linea>',
      };
      continue;
    }

    if (current && current.declaredName === null) {
      const named = STEP_NAME_RE.exec(line);
      if (named) current.declaredName = scalar(named[1]);
    }
  }

  close(yml.length);
  return steps;
}

/** Il testo dello step con quel nome, o `null`: usato per le assert mirate. */
export function workflowStep(yml, name) {
  return workflowSteps(yml).find((step) => step.name === name) ?? null;
}
