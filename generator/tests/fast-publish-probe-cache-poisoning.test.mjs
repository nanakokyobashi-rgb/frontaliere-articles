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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
    /POLL_CODE="\$\(curl [\s\S]{0,160}"\$\(probe_url "\$u" "\$i"\)"\)"/,
    'poll_origin deve interrogare l\'URL bustato, non "$u"',
  );

  // Il controllo che vale davvero: NESSUNA riga del passo di verifica passa
  // l'URL canonico nudo come ultimo argomento. `pages_latest` e il rebuild
  // curlano api.github.com, che non è una chiave di cache di questa zona.
  const nudi = verify.split('\n').filter((l) => /"\$u"\s*\)?"?\s*$/.test(l.trim()));
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
    /poll_origin "\$u" 8[\s\S]{0,400}jq -r '\.shards\[\]\.url'/,
    'il loop sull\'apex deve usare poll_origin (una sola implementazione, un solo cache-bust)',
  );
  assert.ok(
    !/for attempt in \$\(seq 1 8\)/.test(verify),
    'il loop inline sull\'apex è tornato: reintroduce il curl nudo sulla chiave di zona',
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
