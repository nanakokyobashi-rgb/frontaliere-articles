/**
 * Fissa QUALE credenziale mergia la PR del mirror, e su quale perimetro.
 * Run with `node --test`.
 *
 * Non è un test di stile: entrambe le cose che verifica falliscono in SILENZIO.
 *
 * 1. Il token. In Remote Config ci sono due PAT e non sono intercambiabili —
 *    `GITHUB_PAT` è un token integration senza Actions write (403 su dispatch,
 *    vedi l'intestazione di generate-article.yml), `GITHUB_PAT_NANAKO` è un PAT
 *    classico con scope `repo` + `workflow`. Peggio ancora sarebbe ricadere su
 *    `GITHUB_TOKEN`: un merge autenticato con quello NON fa scattare
 *    `publish-api.yml` (regola anti-ricorsione), quindi la PR risulterebbe
 *    mergiata e la superficie dati resterebbe vecchia. Nessuna CI diventerebbe
 *    rossa: si vedrebbe solo, settimane dopo, come pagine renderizzate da un
 *    engine che non è quello su main.
 *
 * 2. Il perimetro. `engine-lockstep-auto` è un branch che il mirror possiede in
 *    esclusiva e force-pusha; allargare il filtro a `--state open` senza `--head`
 *    farebbe auto-mergiare qualunque PR aperta di questo repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(here, '../../.github/workflows/auto-merge-engine-lockstep.yml');
const wf = readFileSync(WORKFLOW, 'utf8');

test('mergia con GITHUB_PAT_NANAKO, non con l\'altro PAT', () => {
  assert.match(wf, /GITHUB_PAT_NANAKO/, 'deve usare il PAT che ha Actions write');
  // `GITHUB_PAT` può comparire solo in prosa esplicativa, mai come valore usato.
  const righeAttive = wf
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.ok(
    !/\$\{?GITHUB_PAT\}?[^_]/.test(righeAttive),
    'non deve consumare GITHUB_PAT: è un token integration senza Actions write',
  );
});

test('non ricade MAI su GITHUB_TOKEN per il merge', () => {
  // Asserisce sull'USO, non sulla menzione: il messaggio d'errore del workflow nomina
  // GITHUB_TOKEN in prosa per spiegare perché non lo usa, ed è giusto che lo faccia.
  // Quello che non deve esistere è un RIFERIMENTO alla variabile.
  assert.ok(
    !/\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/.test(wf),
    'non deve ricevere secrets.GITHUB_TOKEN',
  );
  assert.ok(
    !/\$\{?GITHUB_TOKEN\}?\b/.test(wf),
    'non deve leggere $GITHUB_TOKEN: un merge autenticato così non fa scattare publish-api.yml',
  );
  // E il caso "PAT assente" deve essere un errore esplicito, non un ripiego silenzioso.
  assert.match(
    wf,
    /GITHUB_PAT_NANAKO:-\}" \]; then[\s\S]{0,400}exit 1/,
    'senza il PAT deve fallire, non mergiare in un modo che non pubblica',
  );
});

test('è ristretto al branch che il mirror possiede', () => {
  assert.match(wf, /--head engine-lockstep-auto/,
    'senza --head l\'auto-merge prenderebbe qualunque PR aperta del repo');
});

test('usa --merge e non --squash, per non perdere la provenienza', () => {
  // Il commit del mirror porta il SHA del sito da cui l'engine è stato copiato:
  // è l'unico legame fra i due repo, e uno squash lo sostituirebbe col titolo.
  assert.match(wf, /gh pr merge "\$PR" --merge\b/);
  // Solo sulle righe attive: il commento sopra il comando cita --squash per dire
  // perché NON si usa, e asserire sul file intero lo scambierebbe per un uso.
  const attive = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!/--squash/.test(attive));
});

test('un check pendente o rosso NON fa fallire il job', () => {
  // `gh pr checks` esce non-zero quando qualcosa non è verde. Sotto `set -e` questo
  // renderebbe rosso il job per una PR semplicemente ancora in corso — un fallimento
  // che non significa niente e che, ripetendosi ogni due ore, si impara a ignorare.
  assert.match(wf, /\|\| echo "UNKNOWN"/, 'lo stato dei check va catturato, non propagato');
  assert.match(wf, /\*PENDING\*\|\*QUEUED\*\|\*IN_PROGRESS\*\|UNKNOWN\)[\s\S]{0,200}exit 0/);
});
