/**
 * faq-locale-consistency.test.mjs — un articolo ha la chiave `.faq` in un
 * locale e non in un altro. Issue #204. `node --test`.
 *
 * ## Perche' esiste, e cosa NON trovera' se lo lanci oggi
 *
 * La issue diceva «19 articoli hanno la FAQ in en/de/fr ma non in it, 57
 * inconsistenze». Rimisurato: quella direzione e' a ZERO. Rimisurata anche la
 * direzione OPPOSTA (it si', en/de/fr no) con lo stesso metodo: ANCHE quella
 * e' a zero — le 4 istanze riportate inizialmente (`diventare-pastore-ticino`
 * de, `finanze-ticino-consuntivo`/`pasqua-messaggio-di-avvenire`/
 * `svincolo-a2-sigirino-ritardo` fr) erano un artefatto dello strumento di
 * misura, non del corpus: quei 4 file portano byte di controllo C0 altrove
 * (`file(1)` li classifica «data», binari), e un `grep` SENZA `-a` su un file
 * che `file` giudica binario non stampa match — anche quando la stringa
 * cercata c'e', byte per byte. Con `fs.readFileSync(..., 'utf8')` (quello che
 * usa QUESTO test, e quello che usa il vero detector) il campo `.faq` di
 * tutti e 4 risulta presente in TUTTI i locali. Verificato leggendo i byte:
 * i 4 file hanno davvero C0 altrove (bullet-marker e una `<00>c1usbildung`
 * mai riparata) — un difetto vero, ma di un'ALTRA classe (issue #220), non
 * di questa.
 *
 * Questo banco resta comunque necessario: la prossima generazione che perde
 * una FAQ in un locale deve farlo fallire, non solo `grep -a` a mano.
 *
 * ## Perche' su `fs.readFileSync` e non su `grep`
 *
 * `content/blog-body/**` non e' garantito ASCII: i 28 file con byte C0 di
 * oggi rendono `file(1)` binari, e uno script di controllo che si affidi a
 * `grep` senza `-a`/`--text` sbaglierebbe ESATTAMENTE come ha sbagliato la
 * prima misura di questa issue. Leggere come testo (`utf8`) e cercare la
 * sottostringa e' immune per costruzione: i byte di controllo restano
 * caratteri di stringa validi, non fanno percepire il file come binario a
 * chi lo legge cosi'.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALES = ['it', 'en', 'de', 'fr'];
const BODY_DIRS = ['blog-body', 'blog-body-ch'];

/**
 * Vero se il file porta la chiave `.faq` ANCORATA a `id` — non la prima chiave
 * `.faq` incontrata nel file a prescindere da quale id la possiede. Stesso
 * anti-pattern gia' corretto in `faqQuestionsInBodyText` per #289: un file
 * body oggi porta un solo id (il nome del file), ma niente nel formato lo
 * impedisce strutturalmente, e senza l'ancora una `.faq` che appartiene a un
 * id estraneo verrebbe attribuita all'id del filename — mascherando
 * esattamente l'inconsistenza #204 che questo test esiste per catturare.
 */
function hasFaqKeyForId(text, id) {
  const idPart = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`'blog\\.article\\.${idPart}\\.faq'\\s*:`).test(text);
}

/** { [bodyDir]: { [id]: { [locale]: bool } } }, letto SEMPRE come testo utf8. */
function scanFaqPresence(root) {
  const byDir = {};
  for (const bodyDir of BODY_DIRS) {
    const perId = {};
    for (const locale of LOCALES) {
      const dir = path.join(root, 'content', bodyDir, locale);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.ts')) continue;
        const id = name.slice(0, -3);
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        (perId[id] ??= {})[locale] = hasFaqKeyForId(text, id);
      }
    }
    byDir[bodyDir] = perId;
  }
  return byDir;
}

describe('corpus pubblicato — .faq coerente sui quattro locali', () => {
  it('i corpi sono davvero sul disco (un worktree sparse non materializza content/)', () => {
    const dir = path.join(ROOT, 'content', 'blog-body', 'it');
    assert.ok(fs.existsSync(dir), 'content/blog-body/it assente: il gate passerebbe a vuoto');
    assert.ok(fs.readdirSync(dir).length > 3000, 'troppo pochi corpi IT letti');
  });

  it('zero id con .faq in un locale e non in un altro, in ENTRAMBE le direzioni', () => {
    const byDir = scanFaqPresence(ROOT);
    const offenders = [];
    for (const [bodyDir, perId] of Object.entries(byDir)) {
      for (const [id, perLocale] of Object.entries(perId)) {
        const present = LOCALES.filter((l) => perLocale[l] === true);
        const absent = LOCALES.filter((l) => l in perLocale && perLocale[l] === false);
        if (present.length > 0 && absent.length > 0) {
          offenders.push(`${bodyDir}/${id}: presente in [${present.join(',')}], assente in [${absent.join(',')}]`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'la chiave .faq non e\' coerente sui quattro locali per questi id (vedi issue #204). ' +
        'Verifica prima con fs.readFileSync utf8 (non grep senza -a: i file con C0 sembrano binari e nascondono match veri).',
    );
  });
});
