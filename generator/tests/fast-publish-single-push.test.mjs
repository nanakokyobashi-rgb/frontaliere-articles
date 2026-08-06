/**
 * Un solo push per shard e per locale. Run with `node --test`.
 *
 * IL DIFETTO. `fast-publish-article` pushava due volte allo STESSO repo shard nello stesso
 * step: prima i file dell'articolo, poi la griglia dell'hub. Ogni push innesca una build
 * GitHub Pages, e due build concorrenti sullo stesso repo si ostacolano — nello storico di
 * `frontaliere-articolisvizzera-it` ogni pubblicazione compariva come una COPPIA allo stesso
 * minuto, una `built` e una `errored`, per giorni.
 *
 * PERCHÉ NESSUNO SE N'ERA ACCORTO. Finché una delle due build passava, il sito restava
 * corretto e il difetto non aveva sintomi. Il 2026-08-06 alle 11:34 hanno fallito entrambe:
 * l'articolo era committato nello shard (21 KB, verificato via API) e l'origin rispondeva 404
 * ore dopo, perché Pages continuava a servire l'ultima build riuscita. Cinque run su venti in
 * due giorni, su articoli diversi.
 *
 * PERCHÉ UN TEST E NON SOLO LA FIX. Il commento che stava sul secondo push aveva già scritto
 * «this change doubles the pushes per article»: il raddoppio era noto e accettato, mitigato
 * mettendo il push dell'hub per ultimo e non fatale. Quella mitigazione copriva il fallimento
 * dello script, non la corsa fra build che sta fuori dal runner. Un secondo push reintrodotto
 * in buona fede tornerebbe a rompere in modo intermittente e silenzioso, che è il motivo per
 * cui il vincolo va asserito e non solo commentato.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wf = readFileSync(resolve(here, '../../.github/workflows/fast-publish-article.yml'), 'utf8');

/** Solo le righe eseguibili: i commenti citano il difetto e lo descriverebbero come presente. */
const attive = wf
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

test('le landing dell\'hub viaggiano nella stessa invocazione dell\'articolo', () => {
  assert.match(
    attive,
    /push-article-shard-incremental\.sh[\s\S]{0,120}"\$\{paths\[@\]\}" \$\{hpaths\[@\]\+"\$\{hpaths\[@\]\}"\}/,
    'articolo e hub devono stare nello stesso push, altrimenti tornano due build Pages',
  );
});

test('non esiste più un secondo loop che pusha solo l\'hub', () => {
  // La forma esatta del vecchio blocco: un loop sui locali che invocava il pusher con i soli
  // hpaths. È quello che va impedito, non il numero di occorrenze — il fallback qui sotto è
  // una seconda occorrenza legittima.
  assert.ok(
    !/push-article-shard-incremental\.sh[\s\S]{0,80}"\$dist" "\$\{hpaths\[@\]\}"/.test(attive),
    'un push dedicato alle sole landing ricrea la corsa fra build Pages',
  );
});

test('il fallback conserva la severità: l\'articolo è duro, l\'hub è morbido', () => {
  // Se il push combinato fallisce si riprova con il solo articolo: una pagina hub malformata
  // non deve poter impedire la pubblicazione, che era la proprietà garantita dal vecchio
  // `|| echo ::warning::` sul push separato.
  assert.match(attive, /combined push failed for \$shard\/\$loc/);
  assert.match(
    attive,
    /retrying with the article alone[\s\S]{0,200}push-article-shard-incremental\.sh[\s\S]{0,80}"\$\{paths\[@\]\}"\s*$/m,
    'il retry deve passare i soli path dell\'articolo',
  );
});

test('hpaths vuoto non rompe il push sotto `set -u`', () => {
  // `"${hpaths[@]}"` su array vuoto con `set -u` è un unbound variable in bash < 4.4 e un
  // argomento vuoto altrove; l'espansione `${hpaths[@]+...}` è ciò che rende sicuro il caso
  // "nessuna landing da aggiornare", che è la maggioranza delle pubblicazioni.
  assert.match(attive, /\$\{hpaths\[@\]\+"\$\{hpaths\[@\]\}"\}/);
  assert.match(attive, /hpaths=\(\)/, 'hpaths va inizializzato a vuoto a ogni locale');
});
