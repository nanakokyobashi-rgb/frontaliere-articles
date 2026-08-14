/**
 * article-identity-protocol.test.mjs — il protocollo fra lo schema del prompt
 * e i due campi che diventano URL: `id` e `slugs`. `node --test`.
 *
 * ## Il difetto che sorveglia (issue #138 punto 3)
 *
 * Lo schema mostrava i due campi con valori d'esempio che erano SLUG VALIDI:
 *
 *     "id": "kebab-case-3-5-words-max-40-chars",
 *     "slugs": { "it": "slug-it", "en": "slug-en", "de": "slug-de", "fr": "slug-fr" },
 *
 * Segnaposto e risposta nello stesso spazio sintattico — la forma esatta di
 * #188, dove le due liste condividevano le parentesi quadre. E come li' il
 * clamp a indice 0, qui il parsing INDOVINAVA: `inspectSlugForPromptPlaceholder()`
 * toglieva il prefisso e teneva il resto (`slug-gaggiolo-traffic` →
 * `gaggiolo-traffic`), cioe' assumeva che il testo incollato al segnaposto
 * fosse la scelta del modello. La stessa stringa e' compatibile con uno slug
 * legittimo: e' indecidibile, e la decisione veniva presa lo stesso.
 *
 * Costo misurato (2026-08-09, `slugs.json` pubblicato): 24 slug vivi su 8
 * articoli piu' 4 `id`, tutti 200 e tutti in sitemap.
 *
 * ## Cosa pinna questo file, e cosa lo rende non vacuo
 *
 * L'asserzione che conta e' la 2: **un riferimento ambiguo non deve produrre
 * un valore**. Un test che si limitasse a `ok === false` resterebbe verde
 * anche se il rigetto tornasse a portarsi dietro il resto recuperato, quindi
 * ogni caso ambiguo verifica ANCHE che nel verdetto non compaia nessun campo
 * che somigli a uno slug utilizzabile. E' quella coppia che va rossa se il
 * parsing torna a indovinare.
 *
 * 1. SINTASSI — i segnaposto del template non sono piu' risposte valide,
 *    misurato con `identitySyntaxOverlap()` sui letterali RI-ESTRATTI da
 *    `create-article.mjs` (non su quelli del modulo: altrimenti misurerebbe se
 *    stesso).
 * 2. RIFIUTO  — il parsing rigetta e non recupera.
 * 3. WIRING   — `create-article.mjs` chiama davvero il protocollo sui due
 *    campi, e non contiene piu' i due recuperi che sono stati tolti.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ID_PLACEHOLDER,
  IDENTITY_PLACEHOLDERS,
  IDENTITY_REJECTION,
  identityCorrectionNote,
  identitySyntaxOverlap,
  parseArticleIdentityField,
  slugPlaceholder,
} from '../scripts/lib/prompt-placeholder-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');
const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

/**
 * Il corpo di `validate()`, che e' il parser della risposta al prompt. Stessa
 * tecnica di `sliceFn()` in slug-placeholder-guard.test.mjs: dalla firma alla
 * prima riga che e' esattamente `}` in colonna 0.
 */
const validateBody = (() => {
  const header = 'function validate(data, opts = {}) {';
  const start = src.indexOf(header);
  assert.notEqual(start, -1, `"${header}" non trovato: aggiornare il delimitatore, non cancellare le asserzioni`);
  const endRel = src.slice(start).search(/\n\}\n/);
  assert.notEqual(endRel, -1, 'chiusura di validate() non trovata');
  return src.slice(start, start + endRel + 2);
})();

/**
 * Lo stesso corpo senza le righe di commento. Le asserzioni di ASSENZA vanno
 * fatte qui: il codice tolto e' citato per esteso nel commento che spiega
 * perche' e' stato tolto, e un `includes()` sul sorgente grezzo lo ritroverebbe
 * li' — un test rosso su una prosa e' rumore, non un segnale.
 */
const validateCode = validateBody
  .split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n');

/**
 * Ri-estrae dal blocco schema del prompt i valori dei DUE campi d'identita'.
 * Stesse ancore di `extractSchemaLiterals()` in prompt-placeholder-guard.test.mjs.
 */
function extractIdentityLiterals() {
  const start = src.indexOf('Genera JSON (no markdown, no code fences):');
  assert.ok(start > 0, "ancora dello schema JSON non trovata in create-article.mjs");
  const end = src.indexOf('\nREGOLE FINALI:', start);
  assert.ok(end > start, 'chiusura dello schema JSON non trovata');
  const block = src.slice(start, end);

  const idM = block.match(/"id"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  assert.ok(idM, 'il campo `id` non compare piu\' nello schema del prompt');

  const slugsM = block.match(/"slugs"\s*:\s*\{([^}]*)\}/);
  assert.ok(slugsM, 'il campo `slugs` non compare piu\' nello schema del prompt');
  const slugLits = [...slugsM[1].matchAll(/"[a-z]{2}"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);

  return { idLiterals: [idM[1]], slugLiterals: slugLits };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. SINTASSI — i due campi non sono piu' confondibili con una risposta
// ═══════════════════════════════════════════════════════════════════════════

describe('sintassi — il segnaposto non e\' piu\' uno slug valido', () => {
  const { idLiterals, slugLiterals } = extractIdentityLiterals();

  it('lo schema mostra un `id` e quattro `slugs`', () => {
    assert.equal(idLiterals.length, 1);
    assert.equal(slugLiterals.length, 4, `estratti ${slugLiterals.length} slug dallo schema invece di 4`);
  });

  it('IL DIFETTO: nessun segnaposto d\'identita\' e\' esso stesso uno slug valido', () => {
    const overlap = identitySyntaxOverlap(idLiterals, slugLiterals);
    assert.deepEqual(
      overlap.problems,
      [],
      'i segnaposto dello schema sono di nuovo indistinguibili da una risposta:\n  ' + overlap.problems.join('\n  '),
    );
    assert.equal(overlap.ok, true);
  });

  it('la forma pre-#138 sarebbe rossa qui — la misura discrimina davvero', () => {
    const before = identitySyntaxOverlap(
      ['kebab-case-3-5-words-max-40-chars'],
      ['slug-it', 'slug-en', 'slug-de', 'slug-fr'],
    );
    assert.equal(before.ok, false, 'la misura non vede nemmeno lo schema che ha causato la issue: e\' vacua');
    assert.ok(
      before.problems.some((p) => p.includes('e\' esso stesso uno slug valido')),
      `problemi attesi sullo schema vecchio, ottenuti: ${JSON.stringify(before.problems)}`,
    );
  });

  it('il template usa esattamente i segnaposto del modulo', () => {
    assert.deepEqual(
      [...idLiterals, ...slugLiterals],
      [...IDENTITY_PLACEHOLDERS],
      'template e modulo si sono disallineati sui segnaposto d\'identita\'',
    );
  });

  it('la specifica di formato non e\' andata persa insieme al vecchio segnaposto', () => {
    // Il valore vecchio (`kebab-case-3-5-words-max-40-chars`) ERA la specifica.
    // Delimitarlo senza portarsela dietro avrebbe tolto al modello
    // l'informazione insieme all'ambiguita'.
    assert.match(idLiterals[0], /kebab-case/);
    assert.match(idLiterals[0], /3-5 parole/);
    assert.match(idLiterals[0], /max 40 char/);
  });

  it('il segnaposto di `slugs.it` DICE che vale `id` — e\' la conflazione della issue', () => {
    // `validate()` fa `data.slugs.it = data.id` sempre: chiedere un valore
    // indipendente significa chiederne due per un URL solo e scartarne uno.
    const itLit = slugLiterals[0];
    assert.match(itLit, /SLUG:it/);
    assert.match(itLit, /= ID/, `il segnaposto di slugs.it non nomina piu' l'id: "${itLit}"`);
  });

  it('il costo sul prompt resta dentro il ratchet dei token', () => {
    // PROMPT_TOKEN_CEILING aveva 23 token di margine sul ramo news-al-retry.
    // La specifica sta DENTRO il token proprio per questo: una riga di prosa
    // accanto allo schema ne costava 162 e sfondava il tetto.
    const nuovi = [...idLiterals, ...slugLiterals].join('').length;
    const vecchi = ['kebab-case-3-5-words-max-40-chars', 'slug-it', 'slug-en', 'slug-de', 'slug-fr'].join('').length;
    assert.ok(
      nuovi - vecchi <= 60,
      `i segnaposto sono cresciuti di ${nuovi - vecchi} caratteri: news-prompt-token-budget.test.mjs ` +
        'e\' il gate che lo misura davvero, ma oltre questa soglia va riletto prima di spedire',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. RIFIUTO — il parsing non indovina
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Nessun campo del verdetto puo' contenere qualcosa di utilizzabile come slug.
 *
 * E' l'asserzione anti-vacuita' del file: senza, un rigetto che continuasse a
 * calcolare il resto recuperato (`{ok:false, slug:'gaggiolo-traffic'}`) e un
 * chiamante che lo usasse passerebbero questo test.
 */
function assertNothingRecovered(verdict, forbidden) {
  assert.equal(verdict.ok, false);
  for (const [key, val] of Object.entries(verdict)) {
    if (key === 'detail' || typeof val !== 'string') continue;
    assert.notEqual(
      val,
      forbidden,
      `il verdetto porta ancora il resto recuperato in \`${key}\`: il parsing sta indovinando`,
    );
  }
  assert.equal(verdict.value, undefined, 'un rigetto non puo\' avere un `value`: sarebbe un indovinello');
}

describe('rifiuto — un\'eco del segnaposto non diventa mai un URL', () => {
  it('il segnaposto verbatim e\' rigettato su entrambi i campi', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const v = parseArticleIdentityField(slugPlaceholder(locale), { field: 'slug', locale });
      assert.equal(v.ok, false, `${slugPlaceholder(locale)} accettato come slug`);
      assert.equal(v.rejection, IDENTITY_REJECTION.PLACEHOLDER_ECHO);
    }
    const idV = parseArticleIdentityField(ID_PLACEHOLDER, { field: 'id' });
    assert.equal(idV.ok, false);
    assert.equal(idV.rejection, IDENTITY_REJECTION.PLACEHOLDER_ECHO);
  });

  it('IL DIFETTO: il segnaposto con contenuto incollato NON viene recuperato', () => {
    // La famiglia misurata in produzione, nella forma che il nuovo template
    // produrrebbe: `slug-gaggiolo-traffic` era diventato `gaggiolo-traffic`.
    const v = parseArticleIdentityField('<<SLUG:en>>-gaggiolo-traffic', { field: 'slug', locale: 'en' });
    assertNothingRecovered(v, 'gaggiolo-traffic');
    assert.equal(v.rejection, IDENTITY_REJECTION.PLACEHOLDER_ECHO);
  });

  it('IL DIFETTO, forma storica: `slug-…` e\' AMBIGUO, quindi rigettato senza recupero', () => {
    const v = parseArticleIdentityField('slug-gaggiolo-traffic', {
      field: 'slug',
      locale: 'en',
      legacyLeaked: true,
    });
    assertNothingRecovered(v, 'gaggiolo-traffic');
    assert.equal(v.rejection, IDENTITY_REJECTION.AMBIGUOUS_LEGACY_SHAPE);
  });

  it('IL DIFETTO, dal lato id: `kebab-case-turismo-ticino` non diventa `turismo-ticino`', () => {
    const v = parseArticleIdentityField('kebab-case-turismo-ticino', { field: 'id', legacyLeaked: true });
    assertNothingRecovered(v, 'turismo-ticino');
    assert.equal(v.rejection, IDENTITY_REJECTION.AMBIGUOUS_LEGACY_SHAPE);
  });

  it('lo scambio fra i due campi ha una ragione propria — e\' la conflazione della issue', () => {
    const idGotSlug = parseArticleIdentityField(slugPlaceholder('it'), { field: 'id' });
    assert.equal(idGotSlug.rejection, IDENTITY_REJECTION.CROSS_FIELD_ECHO);
    const slugGotId = parseArticleIdentityField(ID_PLACEHOLDER, { field: 'slug', locale: 'en' });
    assert.equal(slugGotId.rejection, IDENTITY_REJECTION.CROSS_FIELD_ECHO);
  });

  it('un valore assente e\' `empty`, NON un\'ambiguita\': il chiamante lo sintetizza dal titolo', () => {
    for (const empty of [undefined, null, '', '   ']) {
      const v = parseArticleIdentityField(empty, { field: 'id' });
      assert.equal(v.ok, false);
      assert.equal(v.rejection, IDENTITY_REJECTION.EMPTY, `"${empty}" non classificato come empty`);
    }
  });

  it('gli slug legittimi passano intatti — il rigetto non e\' un rifiuto di tutto', () => {
    const buoni = [
      'gaggiolo-traffico-frontalieri',
      'terzo-pilastro-3a-svizzero-vantaggi-2026',
      'frontaliere-piastrellista-ticino-stipendio-requisiti',
      'sluggish-market-ticino', // inizia per "slug" ma non e' il prefisso del segnaposto
    ];
    for (const slug of buoni) {
      const v = parseArticleIdentityField(slug, { field: 'slug', locale: 'it' });
      assert.equal(v.ok, true, `falso positivo su uno slug legittimo: "${slug}" (${v.rejection})`);
      assert.equal(v.value, slug);
    }
  });

  it('la nota di correzione nomina la ragione e i due campi', () => {
    const note = identityCorrectionNote(IDENTITY_REJECTION.CROSS_FIELD_ECHO, { field: 'id' });
    assert.match(note, /RIGETTATO/);
    assert.match(note, /non sono sinonimi/);
    assert.match(identityCorrectionNote(IDENTITY_REJECTION.AMBIGUOUS_LEGACY_SHAPE, { field: 'slugs' }), /kebab-case/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. WIRING — il protocollo e' cablato, e i due recuperi sono spariti
// ═══════════════════════════════════════════════════════════════════════════

describe('wiring — create-article.mjs usa il protocollo sui due campi', () => {
  it('importa il protocollo dal guard dei segnaposto', () => {
    assert.match(src, /parseArticleIdentityField,?\n?/);
    assert.match(src, /from '\.\/lib\/prompt-placeholder-guard\.mjs'/);
  });

  it('lo invoca sul campo `id` e sul campo `slug`', () => {
    assert.match(src, /parseArticleIdentityField\(data\.id, \{\s*\n?\s*field: 'id'/);
    assert.match(src, /parseArticleIdentityField\(original, \{ field: 'slug', locale \}\)/);
  });

  it('IL DIFETTO: dentro `validate()` nessuno dei due recuperi e\' rimasto', () => {
    // La misura e' ristretta a `validate()`, che e' il parser della RISPOSTA
    // AL PROMPT — cio' che #138 punto 3 nomina. `deriveAndSanitizeArticleSlugs()`
    // tiene di proposito il recupero del resto: e' la rete dell'ULTIMO
    // passaggio, la attraversano i quattro produttori secondari che il prompt
    // non lo vedono mai, e il suo comportamento e' pinnato da
    // slug-placeholder-guard.test.mjs («il resto del segnaposto vince sul
    // titolo»). Cambiarlo e' una decisione diversa da questa, su valori che
    // non arrivano dallo schema.
    assert.equal(
      validateCode.includes('const recovered = looksLikeHint ?'),
      false,
      'il recupero del resto dell\'id e\' tornato in validate(): e\' l\'indovinello che #138 punto 3 toglie',
    );
    assert.equal(
      validateCode.includes('check.slug ||'),
      false,
      'il recupero del resto dello slug e\' tornato in validate(): `check.slug` era il resto del segnaposto',
    );
  });

  it('il rigetto dell\'id fa RIGENERARE (qualityReject), non ripiega', () => {
    const i = src.indexOf('id RIGETTATO');
    assert.ok(i > 0, 'il rigetto dell\'id non e\' piu\' nel sorgente');
    const blocco = src.slice(i, i + 400);
    assert.match(blocco, /err\.qualityReject = true/);
    assert.match(blocco, /throw err/);
  });

  it('il rigetto di uno slug en/de/fr cade sull\'italiano e lo marca PROVVISORIO', () => {
    const i = src.indexOf('[slug-identity]');
    assert.ok(i > 0, 'il rigetto dello slug non e\' piu\' nel sorgente');
    const blocco = src.slice(i, i + 1600);
    assert.match(blocco, /data\.slugs\[locale\] = data\.slugs\.it;/);
    assert.match(
      blocco,
      /markProvisionalItSlug\(data, locale\);/,
      'senza il marchio, lo slug italiano di ripiego torna indistinguibile da uno scelto (#191)',
    );
  });

  it('il protocollo legge il valore GREZZO, prima della sanitizzazione', () => {
    const raw = src.indexOf("parseArticleIdentityField(original, { field: 'slug', locale })");
    const sanitize = src.indexOf('data.slugs[locale] = truncateSlugAtWordBoundary(');
    assert.ok(raw > 0 && sanitize > 0);
    assert.ok(
      raw < sanitize,
      'il protocollo gira DOPO la sanitizzazione: `<<SLUG:en>>` sarebbe gia\' diventato `slug-en`, ' +
        'cioe\' la forma ambigua che questa fix toglie',
    );
  });
});
