/**
 * Il nesso editoriale e' deciso da titolo e id, perche' il corpo generato si piega
 * all'angolo che il prompt pretende. Gli esempi dell'audit GEO del 2026-10-31 sono
 * i casi reali: se uno passa, il gate non serve a niente.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertArticleRelevance,
  classifyArticleRelevance,
  isOffTopicHeadline,
} from '../scripts/lib/article-relevance-gate.mjs';

const FILLER_FRONTALIERI = 'I frontalieri del Ticino e la Svizzera seguono il tema. '.repeat(10);

for (const [id, title, family] of [
  ['como-napoli-pareggio-2026', 'Como-Napoli 0-0: Nico Paz brilla, ma Douvikas e Diao non concretizzano', 'sport'],
  ['openjobmetis-trieste-vittoria-kastritis', 'Varese batte Trieste: analisi e dichiarazioni', 'sport'],
  ['blackout-internet-iran-70-giorni', 'Blackout internet in Iran: 70 giorni di disconnessione', 'esteri'],
  ['burraco-solidale-buguggiate', 'Burraco benefico a Buguggiate: 140 partecipanti per ABAD ETS', 'giochi'],
  ['sospensione-lavori-muro-anti-migranti-big-bend-texas', 'Texas, sospesi i lavori per il muro anti-migranti a Big Bend', 'esteri'],
]) {
  test(`fuori tema anche con il corpo imbottito di parole giuste: ${id}`, () => {
    const verdict = classifyArticleRelevance({ section: 'frontaliere', id, title, body: FILLER_FRONTALIERI });
    assert.equal(verdict.relevant, false);
    assert.equal(verdict.rule, 'fuori-tema');
    assert.equal(verdict.family, family);
  });
}

for (const [id, title] of [
  ['nathan-borradori-ambri-2030', 'Nathan Borradori, rinnovo con l\'Ambrì Piotta fino al 2030'],
  ['fc-lugano-pareggio', 'Il Lugano pareggia a Basilea'],
  ['cassis-aragchi-colloquio-iran', 'Cassis sente Araghchi: colloquio sull\'Iran'],
  ['maratona-bilaterali-iii-consiglio', 'Maratona sui Bilaterali III in Consiglio'],
  ['ferrovia-retica-taiwan', 'La Ferrovia retica a Taiwan'],
  ['varese-lavoratori-nero-2026', 'Varese, oltre 50 lavoratori in nero scoperti'],
  ['frontalieri-trump-dazi', 'Dazi di Trump: cosa cambia per i frontalieri'],
]) {
  test(`il nesso dichiarato salva anche una parola da famiglia fuori tema: ${id}`, () => {
    assert.deepEqual(classifyArticleRelevance({ section: 'frontaliere', id, title }), { relevant: true });
  });
}

test('cronaca e cultura delle province di confine restano: la decisione del 2026-09-25 regge', () => {
  for (const [id, title] of [
    ['arresto-rapina-mediaworld-varese', 'Varese, ruba al MediaWorld e spintona la guardia: arrestato'],
    ['saronno-supermercato-evacuati', 'Fumo e odore di bruciato a Saronno'],
    ['film-the-sea-varese-gaza-2026', 'A Varese il film The Sea su Gaza'],
  ]) {
    assert.deepEqual(classifyArticleRelevance({ section: 'frontaliere', id, title }), { relevant: true }, id);
  }
});

test('senza ancore: nessun nesso nel titolo e nessuna parola forte nel corpo', () => {
  const article = {
    section: 'frontaliere',
    id: 'real-madrid-caos-rissa-tchouameni-valverde',
    title: 'Real Madrid, caos e rissa fra Tchouameni e Valverde',
    excerpt: 'Spogliatoio in tensione',
    body: 'Lo spogliatoio del club spagnolo e\' in tensione.',
  };
  assert.equal(classifyArticleRelevance(article).rule, 'senza-ancore');
  assert.equal(classifyArticleRelevance({ ...article, body: 'La Svizzera osserva.' }).relevant, true);
});

test('senza ancore vale solo per la sezione frontaliere: svizzera e cantoni lo sono per costruzione', () => {
  const article = { id: 'rbh-herisau-piu-risorse', title: 'RBH, a Herisau piu\' risorse' };
  assert.equal(classifyArticleRelevance({ ...article, section: 'canton-appenzello' }).relevant, true);
  assert.equal(classifyArticleRelevance({ ...article, section: 'svizzera' }).relevant, true);
});

test('una famiglia fuori tema vale in ogni sezione: il Texas stava nella sezione svizzera', () => {
  const verdict = classifyArticleRelevance({
    section: 'svizzera',
    id: 'sospensione-lavori-muro-anti-migranti-big-bend-texas',
    title: 'Texas, sospesi i lavori per il muro anti-migranti a Big Bend',
  });
  assert.equal(verdict.rule, 'fuori-tema');
});

test('il rifiuto in generazione e\' un rifiuto del topic-gate: il ranker prosegue', () => {
  assert.throws(
    () => assertArticleRelevance({
      id: 'como-roma-serie-a-orario',
      content: { it: { title: 'Como-Roma di Serie A: l\'orario', excerpt: '', body1: FILLER_FRONTALIERI } },
    }, 'frontaliere'),
    (error) => error.topicGateAbort === true && /topic-gate abort/.test(error.message) && /fuori-tema/.test(error.message),
  );
  assert.doesNotThrow(() => assertArticleRelevance({
    id: 'frontalieri-ticino-2026',
    content: { it: { title: 'Frontalieri in Ticino nel 2026', excerpt: '', body1: 'Testo.' } },
  }, 'frontaliere'));
});

test('filtro prima della spesa: decide solo sulla headline, senza guardare la sezione', () => {
  assert.equal(isOffTopicHeadline('Serie A, il Como pareggia a Napoli'), true);
  assert.equal(isOffTopicHeadline('Partita IVA per frontalieri: cosa cambia'), false);
  assert.equal(isOffTopicHeadline('Consiglio federale: nuove regole sul lavoro'), false);
});
