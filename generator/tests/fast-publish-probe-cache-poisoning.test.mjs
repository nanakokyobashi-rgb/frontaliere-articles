/**
 * Il gate di `fast-publish-article` non deve avvelenare la cache che il purge
 * ha appena pulito. Run with `node --test`.
 *
 * ## Il difetto (issue #114)
 *
 * Lo step «Purge the edge cache for what was published» sta PRIMA di «Verify
 * the article is actually readable», e dopo la verifica non c'era nient'altro.
 * La verifica interrogava gli URL **nudi** — l'origin dello shard per il gate
 * duro, l'apex per quello morbido — fino a 12 × 15s per locale, più un rebuild
 * di Pages e altri 12. Quegli URL sono **chiavi di cache**, e interrogarne una
 * mentre lo shard è ancora `building` ci scrive dentro un 404 che nessuno
 * ripulisce.
 *
 * Forma della #114: articolo vivo, origin 200, sitemap che lo annuncia, e
 * l'apex che serve `404` con `cf-cache-status: HIT` e `age` crescente — **sulla
 * locale che il gate aveva appena visto verde**.
 *
 * ## Le due sonde avvelenano cache DIVERSE, e la storia ovvia è sbagliata
 *
 * Misurato con `curl` il 2026-08-09, ed è la ragione per cui questo test
 * asserisce su ENTRAMBE le sonde e non solo su quella dell'origin:
 *
 *   `origin-<shard>-<loc>.frontaliereticino.ch` → `server: GitHub.com`, nessun
 *   `cf-cache-status`, nessun `cf-ray`. L'host è **DNS-only**: una richiesta
 *   esterna non entra mai in Cloudflare, quindi NON può scrivere la entry che
 *   `locale-router.js` legge (quella la crea solo la subrequest del Worker).
 *   Colpisce invece il Fastly di GitHub, che negative-cachea: su un 404,
 *   `x-cache: MISS` poi `HIT`, `x-cache-hits: 1`.
 *
 *   `frontaliereticino.ch` → `server: cloudflare`, e su un 404
 *   `cf-cache-status: MISS` poi `HIT` con `s-maxage=7200`. **Questa** è la
 *   entry che riceve un lettore, ed è il loop sull'apex a scriverla.
 *
 * Quindi è la sonda sull'apex a fabbricare la #114. Quella sull'origin non è
 * innocente per un effetto di secondo ordine: il 404 che parcheggia in Fastly
 * viene riservito ai poll successivi **dello stesso gate**, che finisce per
 * rileggere la propria risposta negativa per il resto della finestra.
 *
 * ## Perché un test e non solo la fix
 *
 * Le tre proprietà sono tutte invisibili a occhio, e nessuna rompe la CI se
 * sparisce:
 *
 * 1. Il cache-bust è **una query**. Un `curl "$u"` rimesso in buona fede —
 *    riscrivendo il loop, aggiungendo una locale, copiando lo step altrove —
 *    non fallisce nessun run e riporta il gate a fabbricare 404 di ore.
 * 2. Il secondo purge deve stare **dopo** la verifica. Riordinare gli step non
 *    rompe niente: un purge che torna prima della verifica è verde, utile, e
 *    completamente inutile per la classe per cui esiste.
 * 3. La lista di URL va **letta**, non ricostruita. Due costruzioni divergono,
 *    e la divergenza si manifesta come un purge che logga successo sugli URL
 *    sbagliati.
 *
 * Che la proprietà 1 si perda in un porting non è ipotetico: la metà sul sito
 * della stessa pipeline (`scripts/wait-for-live-article-shards.mjs` su
 * valerielinc-ops/frontaliere-si-o-no) busta le proprie sonde da sempre —
 * `_fpcb=<epoch>` e `Cache-Control: no-cache` — e la reimplementazione in shell
 * arrivata qui l'ha persa per strada senza che nulla lo dicesse.
 *
 * ## 2026-10-08: le asserzioni sul testo non bastavano (issue 2538)
 *
 * La proprietà 1 era scritta e non era vera. `"$(probe_url "$u")"` eseguiva la
 * funzione in una subshell: il contatore si incrementava lì e si perdeva, e
 * ogni sonda di una run portava la stessa chiave. Il testo dello step aveva la
 * forma giusta, quindi i casi qui sopra passavano. Per questo in fondo al file
 * ci sono casi che ESEGUONO le funzioni dello step, con un `curl` che risponde
 * una sequenza di codici e registra l'URL che riceve.
 *
 * Gli stessi casi tengono fermo il secondo difetto dello stesso giorno: dopo il
 * gate della lingua ogni membro del lotto aveva un solo tentativo, e un 503
 * dell'origine (che non dice nulla dell'articolo) valeva come un 404. Una
 * pubblicazione di 78 articoli è finita rossa per un 503 su 308 sonde.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WF = readFileSync(resolve(here, '../../.github/workflows/fast-publish-article.yml'), 'utf8');

/** Solo le righe eseguibili: i commenti descrivono il difetto e lo direbbero presente. */
const soloAttive = (s) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

/**
 * Gli step del job, spezzati sul `- name:` a sei spazi. Testo grezzo e non YAML
 * parsato: `node --test` gira senza dipendenze su questo repo, e ciò che va
 * asserito è shell dentro un blocco `run:`, non struttura YAML.
 */
function steps() {
  const out = [];
  const re = /^ {6}- name: (.+)$/gm;
  const marks = [...WF.matchAll(re)];
  return marks.reduce((acc, m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : WF.length;
    acc.push({ name: m[1].trim(), text: WF.slice(m.index, end) });
    return acc;
  }, out);
}

const STEPS = steps();
const indexOfStep = (name) => STEPS.findIndex((s) => s.name === name);
const stepText = (name) => {
  const s = STEPS.find((x) => x.name === name);
  assert.ok(s, `step «${name}» non trovato: il test è diventato vacuo`);
  return s.text;
};

const PURGE = 'Purge the edge cache for what was published';
const VERIFY = 'Verify the article is actually readable';
const REPURGE = 'Re-purge the edge cache after the verification';

test('i tre step esistono e sono in questo ordine: purge → verifica → ri-purge', () => {
  const p = indexOfStep(PURGE);
  const v = indexOfStep(VERIFY);
  const r = indexOfStep(REPURGE);

  assert.ok(p > -1, `step «${PURGE}» sparito`);
  assert.ok(v > -1, `step «${VERIFY}» sparito`);
  assert.ok(
    r > -1,
    `manca lo step «${REPURGE}»: senza un purge DOPO la verifica, un 404 cachato durante la finestra di build non lo sfratta nessuno (#114)`,
  );

  assert.ok(p < v, 'il purge iniziale deve precedere la verifica');
  assert.ok(
    v < r,
    'il ri-purge DEVE stare dopo la verifica: prima della verifica è già lo step che c\'era, e non copre la finestra in cui il 404 viene cachato',
  );
});

test('il ri-purge gira anche quando la verifica fallisce', () => {
  // È il caso che conta: se la verifica va in timeout, quella locale è stata 404
  // per minuti mentre il mondo poteva raggiungerla. Saltare la pulizia proprio lì
  // la lascia indietro sui run che ne hanno più bisogno.
  assert.match(
    stepText(REPURGE),
    /^ {8}if: always\(\)/m,
    'il ri-purge senza `always()` salta esattamente i run in cui il 404 è stato cachato',
  );
});

test('la lista di URL è scritta una volta e RILETTA, non ricostruita', () => {
  const purge = soloAttive(stepText(PURGE));
  const repurge = soloAttive(stepText(REPURGE));

  assert.match(
    purge,
    /printf '%s\\n' "\$\{urls\[@\]\}" > "\$RUNNER_TEMP\/edge-purge-urls\.txt"/,
    'il primo purge deve persistere la lista per il ri-purge',
  );
  assert.match(repurge, /\$RUNNER_TEMP\/edge-purge-urls\.txt/, 'il ri-purge deve leggere la lista dal file');

  // La costruzione degli URL di origin vive in UN solo step. Una seconda copia
  // nel ri-purge sarebbe libera di divergere, e la divergenza si vede solo come
  // un purge che logga successo su URL che non sono quelli pubblicati.
  const costruzione = /urls\+=\("https:\/\/origin-\$shard-\$loc\.frontaliereticino\.ch\/\$rel"\)/g;
  assert.equal(
    [...purge.matchAll(costruzione)].length,
    2,
    'la costruzione degli URL di origin (articolo + hub) deve stare tutta nel primo purge',
  );
  assert.equal(
    [...repurge.matchAll(costruzione)].length,
    0,
    'il ri-purge non deve ricostruire la lista: due costruzioni divergono in silenzio',
  );
});

test('nessuna sonda della verifica chiede l\'URL canonico nudo', () => {
  const verify = soloAttive(stepText(VERIFY));

  assert.match(verify, /probe_url\(\)/, 'manca il costruttore della query di cache-bust');
  assert.match(
    verify,
    /_fpcb=/,
    'la sonda non porta più una query di cache-bust — e `_fpcb` è il nome che usa già la metà sul sito della stessa pipeline: cambiarlo scollega i due lati da un grep',
  );
  assert.match(
    verify,
    /probe_url "\$u"\n\s+set \+e\n\s+POLL_CODE="\$\(curl [\s\S]{0,160}"\$PROBE_URL"\)"/,
    'poll_origin deve costruire la chiave con una CHIAMATA a probe_url e interrogare $PROBE_URL, non "$u"',
  );
  assert.ok(
    !/\$\(probe_url /.test(verify),
    'probe_url è tornata dentro una sostituzione di comando: lì il contatore si incrementa in una subshell e si perde, e tutte le sonde della run portano la stessa chiave',
  );

  // Il controllo che vale davvero: NESSUNA riga del passo di verifica passa
  // l'URL canonico nudo come ultimo argomento. `pages_latest` e il rebuild
  // curlano api.github.com, che non è una chiave di cache di questa zona.
  // La chiamata che COSTRUISCE la chiave riceve l'URL canonico per mestiere.
  const nudi = verify
    .split('\n')
    .filter((l) => /"\$u"\s*\)?"?\s*$/.test(l.trim()))
    .filter((l) => l.trim() !== 'probe_url "$u"');
  assert.deepEqual(
    nudi,
    [],
    `una sonda chiede ancora "$u" nudo: è una chiave di cache, e il 404 che ci scrive sopravvive al run (#114). Righe: ${JSON.stringify(nudi)}`,
  );
});

test('anche la sonda sull\'apex passa da poll_origin', () => {
  const verify = soloAttive(stepText(VERIFY));

  // Era una copia inline dello stesso loop con un curl nudo, ed è l'unica delle
  // due che raggiunge Cloudflare: gli host origin sono DNS-only, l'apex no. È
  // quindi la sonda che scrive la entry che riceve un lettore.
  assert.match(
    verify,
    /poll_origin "\$u" 1 8[\s\S]{0,400}jq -r '\.shards\[\]\.urls\[\]'/,
    'il loop sull\'apex deve usare poll_origin (una sola implementazione, un solo cache-bust)',
  );
  assert.ok(
    !/for attempt in \$\(seq 1 8\)/.test(verify),
    'il loop inline sull\'apex è tornato: reintroduce il curl nudo sulla chiave di zona',
  );
});

test('il bust è unico anche fra due chiamate a poll_origin sullo stesso URL', () => {
  const verify = soloAttive(stepText(VERIFY));

  // Il loop sull'origin chiama poll_origin due volte sullo STESSO $u quando la
  // prima serie di poll fallisce e scatta il rebuild di Pages: poll → rebuild →
  // poll. Un indice locale al loop (`i` in `for i in $(seq 1 "$attempts")`)
  // riparte da 1 a ogni chiamata, quindi il secondo giro rilegge le stesse 12
  // chiavi bustate che il primo ha appena scritto — invece di rileggerle solo
  // dall'origin ricostruito. Il contatore deve essere globale allo script, non
  // locale a poll_origin, e incrementato dentro probe_url.
  assert.match(
    verify,
    /^ {10}PROBE_SEQ=0\n {10}probe_url\(\) \{/m,
    'PROBE_SEQ deve essere dichiarato UNA volta, fuori da probe_url/poll_origin — non per-chiamata',
  );
  assert.match(
    verify,
    /probe_url\(\) \{[\s\S]{0,200}PROBE_SEQ=\$\(\(PROBE_SEQ \+ 1\)\)/,
    'probe_url deve incrementare un contatore globale, non riusare l\'indice locale del loop chiamante',
  );
  assert.ok(
    !/local u="\$1" i="\$2"/.test(verify),
    'probe_url non deve più derivare la sua unicità dall\'indice locale del poll (resetta a ogni chiamata su uno stesso $u)',
  );
});

test('il cache-bust non esce dagli URL riportati a un umano', () => {
  const verify = soloAttive(stepText(VERIFY));

  // `$1` resta l'URL canonico e `$1` è ciò che finisce nei log e nelle
  // annotation: una query di sonda dentro un `::error::` diventerebbe l'URL che
  // qualcuno apre — o che un altro workflow parsa.
  assert.match(verify, /echo " {2}200 {2}\$u"/, 'il log del successo deve mostrare l\'URL canonico');
  assert.match(verify, /::error::\$u answers \$POLL_CODE/, 'l\'annotation di errore deve nominare l\'URL canonico');
  assert.ok(
    !/::(error|warning|notice)::[^\n]*_fpcb=/.test(verify),
    'una query di sonda è finita in un\'annotation: quello è l\'URL che verrà aperto a mano',
  );
});

// ── Casi eseguiti ────────────────────────────────────────────────────────────

/** Una funzione shell dello step, come sta nel workflow, senza l'indentazione YAML. */
function funzioneDelloStep(nome) {
  const m = new RegExp(`^ {10}${nome}\\(\\) \\{\\n[\\s\\S]*?\\n {10}\\}$`, 'm').exec(stepText(VERIFY));
  assert.ok(m, `funzione «${nome}» non trovata nello step di verifica: il test è diventato vacuo`);
  return m[0].replace(/^ {10}/gm, '');
}

const TETTO_RUN = Number(/^ {10}TRANSIENT_RETRY_BUDGET=(\d+)$/m.exec(stepText(VERIFY))?.[1]);

/**
 * Esegue le funzioni VERE dello step. `curl` risponde, in ordine, i codici dati
 * e registra l'URL che riceve; `sleep` registra l'attesa senza aspettare.
 * Restituisce che cosa ha deciso lo step, le chiavi chieste e le attese.
 */
function eseguiSonde({
  codici,
  comandi,
  tetto = TETTO_RUN,
  funzioni = ['probe_url', 'poll_origin', 'poll_batch_member'],
  shard = SHARD,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'fast-publish-probe-'));
  try {
    const coda = join(dir, 'codici');
    const registro = join(dir, 'registro');
    writeFileSync(coda, codici.map((codice) => `${codice}\n`).join(''));
    writeFileSync(registro, '');
    const script = [
      // Come lo step: una variabile non definita o un comando fallito fermano tutto.
      'set -euo pipefail',
      'shard="$SHARD"',
      'curl() {',
      '  local ultimo codice',
      '  for ultimo in "$@"; do :; done',
      '  codice="$(head -n 1 "$CODA")"',
      '  tail -n +2 "$CODA" > "$CODA.resto" && mv "$CODA.resto" "$CODA"',
      '  printf \'sonda %s\\n\' "$ultimo" >> "$REGISTRO"',
      // «SILENZIO» è curl interrotto prima di poter stampare il codice.
      '  if [ "$codice" = "SILENZIO" ]; then return 0; fi',
      '  printf \'%s\' "${codice:-coda-vuota}"',
      '}',
      'sleep() { printf \'attesa %s\\n\' "$1" >> "$REGISTRO"; }',
      'PROBE_SEQ=0',
      `TRANSIENT_RETRY_BUDGET=${tetto}`,
      ...funzioni.map(funzioneDelloStep),
      ...comandi,
    ].join('\n');
    const esito = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, CODA: coda, REGISTRO: registro, SHARD: shard, GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '2' },
    });
    assert.equal(esito.status, 0, `lo script di prova è uscito con ${esito.status}: ${esito.stderr}`);
    const righe = readFileSync(registro, 'utf8').split('\n').filter(Boolean);
    return {
      uscita: esito.stdout.split('\n').filter((riga) => /^(OK|KO) /.test(riga)),
      sonde: righe.filter((riga) => riga.startsWith('sonda ')).map((riga) => riga.slice('sonda '.length)),
      attese: righe.filter((riga) => riga.startsWith('attesa ')).map((riga) => riga.slice('attesa '.length)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Il giudizio dello step su un membro del lotto: esito, ultimo codice, ritentativi rimasti alla run. */
const membro = (u) =>
  `if poll_batch_member "${u}"; then echo "OK ${u} $POLL_CODE $TRANSIENT_RETRY_BUDGET"; `
  + `else echo "KO ${u} $POLL_CODE $TRANSIENT_RETRY_BUDGET"; fi`;

const ORIGINE = 'https://origin.example.invalid';
const SHARD = 'articoliprova';

test('eseguito: ogni sonda ha una chiave sua, anche sullo stesso percorso', () => {
  // Il difetto: con `"$(probe_url "$u")"` il contatore restava a 0 e le cinque
  // sonde qui sotto chiedevano tutte `…777.2.1`. È il caso che il loop sull'origin
  // incontra davvero: poll → rebuild di Pages → poll, sullo stesso percorso.
  const u = `${ORIGINE}/articolo/`;
  const { sonde } = eseguiSonde({
    codici: [404, 404, 404, 404, 404],
    comandi: [`poll_origin "${u}" 3 || true`, `poll_origin "${u}" 2 || true`],
    funzioni: ['probe_url', 'poll_origin'],
  });
  assert.deepEqual(sonde, [1, 2, 3, 4, 5].map((n) => `${u}?_fpcb=777.2.${SHARD}.${n}`));
});

test('eseguito: due rami della matrice non chiedono mai la stessa chiave', () => {
  // Il contatore riparte da 1 in ogni ramo: senza lo shard nella chiave, due
  // rami della stessa run che sondassero lo stesso URL leggerebbero l'uno la
  // risposta dell'altro.
  const u = `${ORIGINE}/articolo/`;
  const ramo = (shard) => eseguiSonde({
    codici: [404, 404],
    comandi: [`poll_origin "${u}" 2 || true`],
    funzioni: ['probe_url', 'poll_origin'],
    shard,
  }).sonde;
  const a = ramo('articolifrontaliere');
  const b = ramo('articolisvizzera');
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert.deepEqual(a.filter((chiave) => b.includes(chiave)), []);
});

test('eseguito: curl che non stampa un codice vale come nessuna risposta', () => {
  // Interrotto prima del write-out, curl non stampa nulla, o un frammento. Non è
  // una risposta sull'articolo: si legge 000, si ritenta, e l'annotazione non
  // resta con un codice vuoto.
  for (const uscita of ['SILENZIO', '20']) {
    const u = `${ORIGINE}/muto-${uscita}/`;
    const { uscita: esito, sonde } = eseguiSonde({ codici: [uscita, 200], comandi: [membro(u)] });
    assert.deepEqual(esito, [`OK ${u} 200 ${TETTO_RUN - 1}`], `uscita «${uscita}» non ritentata`);
    assert.equal(sonde.length, 2);
  }
  const u = `${ORIGINE}/sempre-muto/`;
  const { uscita: esito } = eseguiSonde({ codici: ['SILENZIO', 'SILENZIO', 'SILENZIO'], comandi: [membro(u)] });
  assert.deepEqual(esito, [`KO ${u} 000 ${TETTO_RUN - 2}`]);
});

test('eseguito: un 503 dell\'origine si ritenta, e il membro del lotto passa', () => {
  const u = `${ORIGINE}/a/`;
  const { uscita, sonde, attese } = eseguiSonde({ codici: [503, 200], comandi: [membro(u)] });
  assert.deepEqual(uscita, [`OK ${u} 200 ${TETTO_RUN - 1}`]);
  assert.equal(sonde.length, 2);
  assert.notEqual(sonde[0], sonde[1], 'il ritentativo deve chiedere una chiave nuova, non rileggere la risposta di prima');
  assert.deepEqual(attese, ['5']);
});

test('eseguito: un 404 fallisce al primo tentativo, senza spendere ritentativi', () => {
  // L'articolo che la build online non contiene: ripetere la sonda non lo ripara.
  const u = `${ORIGINE}/mancante/`;
  const { uscita, sonde, attese } = eseguiSonde({ codici: [404, 200], comandi: [membro(u)] });
  assert.deepEqual(uscita, [`KO ${u} 404 ${TETTO_RUN}`]);
  assert.equal(sonde.length, 1);
  assert.deepEqual(attese, []);
});

test('eseguito: un\'origine che continua a non rispondere fallisce dopo due ritentativi', () => {
  const u = `${ORIGINE}/a/`;
  const { uscita, sonde } = eseguiSonde({ codici: [503, 502, 503, 200], comandi: [membro(u)] });
  assert.deepEqual(uscita, [`KO ${u} 503 ${TETTO_RUN - 2}`]);
  assert.equal(sonde.length, 3);
});

test('eseguito: ciò che non parla dell\'articolo si ritenta; gli altri codici valgono come il 404', () => {
  // 408 e 425 dicono che la richiesta non è stata servita, come 429 e 5xx.
  for (const codice of ['000', 408, 425, 429, 500, 504]) {
    const u = `${ORIGINE}/transitorio-${codice}/`;
    const { uscita, sonde } = eseguiSonde({ codici: [codice, 200], comandi: [membro(u)] });
    assert.deepEqual(uscita, [`OK ${u} 200 ${TETTO_RUN - 1}`], `${codice} non è stato ritentato`);
    assert.equal(sonde.length, 2);
  }
  for (const codice of [301, 403, 410]) {
    const u = `${ORIGINE}/definitivo-${codice}/`;
    const { uscita, sonde } = eseguiSonde({ codici: [codice, 200], comandi: [membro(u)] });
    assert.deepEqual(uscita, [`KO ${u} ${codice} ${TETTO_RUN}`], `${codice} è stato ritentato`);
    assert.equal(sonde.length, 1);
  }
});

test('eseguito: il tetto dei ritentativi è della run, non del percorso', () => {
  // Un'origine ferma non deve moltiplicare la durata del job. Il caso peggiore
  // che il tetto aggiunge è 12 × (8 s di timeout + 5 s di attesa) = 156 s, su
  // un job che ne ha 1.800: chi alza il tetto rifà questo conto.
  assert.equal(TETTO_RUN, 12);
  const percorsi = Array.from({ length: 7 }, (_, i) => `${ORIGINE}/p${i}/`);
  const { uscita, sonde } = eseguiSonde({ codici: Array(30).fill(503), comandi: percorsi.map(membro) });
  // I primi sei spendono due ritentativi a testa; al settimo resta un solo tentativo.
  assert.deepEqual(uscita, percorsi.map((u, i) => `KO ${u} 503 ${Math.max(0, 12 - 2 * (i + 1))}`));
  assert.equal(sonde.length, 6 * 3 + 1);
  assert.equal(new Set(sonde).size, sonde.length, 'due sonde hanno chiesto la stessa chiave');
});

test('il membro del lotto passa da poll_batch_member; il gate della lingua e l\'apex restano com\'erano', () => {
  const verify = soloAttive(stepText(VERIFY));
  assert.match(
    verify,
    /if \[ -n "\$\{origin_locale_gate_started\[\$loc\]:-\}" \]; then\n\s+if poll_batch_member "\$u"; then/,
    'dopo il gate della lingua il membro del lotto deve passare da poll_batch_member',
  );
  // Il primo percorso di ogni lingua aspetta la build: dodici tentativi, come prima.
  assert.match(verify, /origin_locale_gate_started\[\$loc\]=1\n\s*\n?\s+if poll_origin "\$u" 12; then/);
  // L'apex resta a un tentativo e a warning: non decide l'esito dello step.
  assert.match(verify, /if poll_origin "\$u" 1 8; then echo " {2}200 {2}\$u"\n\s+else echo "::warning::/);
  // Lo shard del ramo della matrice fa parte della chiave.
  assert.match(verify, /printf -v PROBE_URL '%s%s_fpcb=%s\.%s\.%s\.%s'[\s\S]{0,160}"\$shard" "\$PROBE_SEQ"/);
  // Un membro che non passa ferma lo step con lo stesso messaggio di prima.
  assert.match(verify, /::error::\$u answers \$POLL_CODE after the locale deployment gate passed"\n\s+fail=1/);
});
