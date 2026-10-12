import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findArticleLocalizedToponymMismatches,
  parseEventsDigestBody2Safe,
  pairEventsByStableKey,
} from '../scripts/lib/localized-toponyms.mjs';
import { repairEventsDigestLocalizedToponyms } from '../scripts/lib/events-digest-localization.mjs';

function incidentArticle() {
  const italianBody2 = [
    '## Gli eventi',
    '',
    '### [Ginevra](/it/events/geneva/)',
    '- **sabato 16:00** — Concerto a Zurigo',
    '- **domenica 20:30** — Festival',
  ].join('\n');
  return {
    id: 'eventi-weekend-ticino',
    imageAlt: {
      it: 'Eventi in Zurigo',
      en: 'Events in Zürich',
      de: 'Veranstaltungen in Zurich',
      fr: 'Événements à Zürich',
    },
    content: {
      it: {
        body2: italianBody2,
        faq: [{ q: 'Eventi in Ginevra?' }],
      },
      en: {
        body2: [
          '## Events',
          '',
          '### [Genève](/en/events/geneva/)',
          '- **Saturday 16:00** — Concert in Zürich',
          '- **Sunday 20:30** — Zürich Film Festival',
        ].join('\n'),
        faq: [{ q: 'Events in Genève?' }],
      },
      de: {
        body2: italianBody2
          .replace('[Ginevra](/it/', '[Ginevra](/de/')
          .replace('Concerto a Zurigo', 'Konzert in Zurich'),
        faq: [{ q: 'Veranstaltungen in Genève?' }],
      },
      fr: {
        body2: italianBody2
          .replace('[Ginevra](/it/', '[Genève](/fr/')
          .replace('Concerto a Zurigo', 'Concert à Zürich'),
        faq: [{ q: 'Événements à Ginevra?' }],
      },
    },
  };
}

describe('repairEventsDigestLocalizedToponyms', () => {
  it('pairs event titles and headings instead of cross-rewriting another event brand', () => {
    const original = incidentArticle();
    const before = findArticleLocalizedToponymMismatches(original);
    assert.ok(before.some(({ locale, code }) => locale === 'en' && code === 'ZH'));

    const repaired = repairEventsDigestLocalizedToponyms(original);
    assert.deepEqual(findArticleLocalizedToponymMismatches(repaired), []);
    assert.match(repaired.content.en.body2, /\[Geneva\]\(\/en\/events\/geneva\/\)/);
    assert.match(repaired.content.en.body2, /Concert in Zurich/);
    assert.match(repaired.content.en.body2, /Zürich Film Festival/);
    assert.match(repaired.content.de.body2, /\[Genf\]\(\/de\/events\/geneva\/\)/);
    assert.match(repaired.content.fr.body2, /Concert à Zurich/);
    assert.equal(repaired.imageAlt.en, 'Events in Zurich');
    assert.equal(repaired.content.en.faq[0].q, 'Events in Geneva?');
    assert.match(original.content.en.body2, /Concert in Zürich/);
    assert.deepEqual(repairEventsDigestLocalizedToponyms(repaired), repaired);
  });

  it('pairs reordered event records by heading, day and time instead of array position', () => {
    const original = incidentArticle();
    const lines = original.content.en.body2.split('\n');
    const saturday = lines.findIndex((line) => line.includes('Saturday 16:00'));
    const sunday = lines.findIndex((line) => line.includes('Sunday 20:30'));
    [lines[saturday], lines[sunday]] = [lines[sunday], lines[saturday]];
    original.content.en.body2 = lines.join('\n');

    const sourceParsed = parseEventsDigestBody2Safe(incidentArticle().content.it.body2);
    const targetParsed = parseEventsDigestBody2Safe(original.content.en.body2);
    const pairs = pairEventsByStableKey(sourceParsed, targetParsed);
    assert.equal(pairs?.length, 2);

    const repaired = repairEventsDigestLocalizedToponyms(original);
    assert.match(repaired.content.en.body2, /Saturday 16:00.*Concert in Zurich/);
    assert.match(repaired.content.en.body2, /Sunday 20:30.*Zürich Film Festival/);
    assert.doesNotMatch(repaired.content.en.body2, /Saturday 16:00.*Concert in Zürich/);
    assert.doesNotMatch(repaired.content.en.body2, /Sunday 20:30.*Zurich Film Festival/);
  });

  it('keeps the canton base path in the stable key when place slugs collide', () => {
    const sourceBody = [
      '## Gli eventi',
      '',
      '### [Ginevra](/eventi/ticino/geneva/)',
      '- **sabato 16:00** — Evento in Zurigo',
      '',
      '### [Ginevra](/eventi/ginevra/geneva/)',
      '- **domenica 20:30** — Secondo evento in Zurigo',
    ].join('\n');
    const targetBody = [
      '## Events',
      '',
      '### [Genève](/en/events/ticino/geneva/)',
      '- **Saturday 16:00** — Event in Zürich',
      '',
      '### [Genève](/en/events/geneva/geneva/)',
      '- **Sunday 20:30** — Second event in Zürich',
    ].join('\n');

    const sourceParsed = parseEventsDigestBody2Safe(sourceBody);
    const targetParsed = parseEventsDigestBody2Safe(targetBody);
    const pairs = pairEventsByStableKey(sourceParsed, targetParsed);

    assert.equal(pairs?.length, 2);
  });

  it('uses one identity for the canton-neutral bucket across localized paths', () => {
    const sourceBody = [
      '## Gli eventi',
      '',
      '### [Buchs](/eventi/altri-cantoni/buchs/)',
      '- **sabato 16:00** — Evento in Zurigo',
    ].join('\n');
    const targetBody = [
      '## Events',
      '',
      '### [Buchs](/en/events/other-cantons/buchs/)',
      '- **Saturday 16:00** — Event in Zürich',
    ].join('\n');

    const pairs = pairEventsByStableKey(
      parseEventsDigestBody2Safe(sourceBody),
      parseEventsDigestBody2Safe(targetBody),
    );

    assert.equal(pairs?.length, 1);
  });

  it('fails closed when rendered event keys are duplicated', () => {
    const original = {
      id: 'eventi-weekend-ticino',
      content: {
        it: {
          body2: [
            '## Gli eventi',
            '',
            '### [Lugano](/eventi/ticino/lugano/)',
            '- **sabato** — Primo evento',
            '- **sabato** — Secondo evento',
            '- **domenica** — Evento in Zurigo',
          ].join('\n'),
        },
        en: {
          body2: [
            '## Events',
            '',
            '### [Lugano](/en/events/ticino/lugano/)',
            '- **Saturday** — First event',
            '- **Saturday** — Second event',
            '- **Sunday** — Event in Zürich',
          ].join('\n'),
        },
      },
    };
    const source = parseEventsDigestBody2Safe(original.content.it.body2);
    const target = parseEventsDigestBody2Safe(original.content.en.body2);
    const pairs = pairEventsByStableKey(source, target);

    assert.equal(pairs, null);
    const repaired = repairEventsDigestLocalizedToponyms(original);
    assert.equal(repaired.content.en.body2, original.content.en.body2);
    assert.ok(findArticleLocalizedToponymMismatches(repaired).some(({ locale, code, type }) => (
      locale === 'en' && code === 'BODY2' && type === 'structure'
    )));
  });

  it('fails closed for an unlinked heading containing ambiguous toponyms', () => {
    const original = incidentArticle();
    original.content.it.body2 = [
      '## Gli eventi',
      '',
      '### Zurigo e Ginevra',
      '',
      '### [Lugano](/eventi/ticino/lugano/)',
      '- **sabato 16:00** — Evento',
    ].join('\n');
    original.content.en.body2 = [
      '## Events',
      '',
      '### Zurich e Ginevra',
      '',
      '### [Lugano](/en/events/ticino/lugano/)',
      '- **Saturday 16:00** — Event',
    ].join('\n');

    const repaired = repairEventsDigestLocalizedToponyms(original);

    assert.equal(repaired.content.en.body2, original.content.en.body2);
    assert.ok(findArticleLocalizedToponymMismatches(repaired).some(({ locale, code, type }) => (
      locale === 'en' && code === 'BODY2' && type === 'structure'
    )));
  });

  it('pairs headings by stable key when an unlinked section changes position', () => {
    const original = incidentArticle();
    original.content.it.body2 = [
      '## Gli eventi',
      '',
      '### [Ginevra](/eventi/ticino/geneva/)',
      '- **sabato 16:00** — Concerto a Zurigo',
      '',
      '### Eventi extra',
      '',
      '### [Zurigo](/eventi/ticino/zurich/)',
      '- **domenica 20:30** — Festival a Ginevra',
    ].join('\n');
    original.content.en.body2 = [
      '## Events',
      '',
      '### More events',
      '',
      '### [Genève](/en/events/ticino/geneva/)',
      '- **Saturday 16:00** — Concert in Zürich',
      '',
      '### [Zürich](/en/events/ticino/zurich/)',
      '- **Sunday 20:30** — Festival in Genève',
    ].join('\n');

    const repaired = repairEventsDigestLocalizedToponyms(original);

    assert.match(repaired.content.en.body2, /\[Geneva\]\(\/en\/events\/ticino\/geneva\/\)/);
    assert.doesNotMatch(repaired.content.en.body2, /\[Genève\]\(\/en\/events\/ticino\/geneva\/\)/);
  });

  it('pairs non-linked canton headings through canonical slug identities', () => {
    const sections = [
      { source: 'Graubünden', target: 'Graubunden', slug: 'graubunden', place: 'venue-gr' },
      { source: 'Genève', target: 'Geneve', slug: 'geneve', place: 'venue-ge' },
      { source: 'Neuchâtel', target: 'Neuchatel', slug: 'neuchatel', place: 'venue-ne' },
      { source: 'Zürich', target: 'Zurich', slug: 'zurich', place: 'venue-zh' },
    ];
    const renderBody = (locale, labelKey) => [
      locale === 'it' ? '## Gli eventi' : '## Events',
      '',
      ...sections.flatMap(({ source, target, slug, place }) => [
        `### ${labelKey === 'source' ? source : target}`,
        '',
        `### [Venue](/${locale === 'it' ? 'eventi' : 'en/events'}/${slug}/${place}/)`,
        `- **${locale === 'it' ? 'sabato' : 'Saturday'} 16:00** — ${locale === 'it' ? 'Evento in Zurigo' : 'Event in Zürich'}`,
        '',
      ]),
    ].join('\n');
    const original = {
      id: 'eventi-weekend-ticino',
      content: {
        it: { body2: renderBody('it', 'source') },
        en: { body2: renderBody('en', 'target') },
      },
    };

    const repaired = repairEventsDigestLocalizedToponyms(original);

    assert.match(repaired.content.en.body2, /Event in Zurich/);
    assert.doesNotMatch(repaired.content.en.body2, /Event in Zürich/);
  });

  it('does not repair body2 when event structure cannot be paired and keeps the gate fail-closed', () => {
    const original = incidentArticle();
    original.content.en.body2 = 'Zürich';

    const repaired = repairEventsDigestLocalizedToponyms(original);

    assert.equal(repaired.content.en.body2, 'Zürich');
    assert.ok(findArticleLocalizedToponymMismatches(repaired).some(({ locale, code, type }) => (
      locale === 'en' && code === 'BODY2' && type === 'structure'
    )));
  });

  it('keeps heading-like and non-record bullet lines inside a multiline event title', () => {
    const body = [
      '## Gli eventi',
      '',
      '### [Ginevra](/it/events/geneva/)',
      '- **sabato 16:00** — Concerto a Zurigo',
      '### Nota interna del titolo',
      '- **Nota** — non è un nuovo evento',
      'dettaglio del titolo',
      '- **domenica 20:30** — Festival a Ginevra',
    ].join('\n');

    const parsed = parseEventsDigestBody2Safe(body);

    assert.ok(parsed);
    assert.equal(parsed.events.length, 2);
    assert.deepEqual(parsed.events[0].lineIndices, [3, 4, 5, 6]);
    assert.deepEqual(parsed.shape, ['2:0', '3:2']);
  });

  it('uses the child block shape to distinguish a blank-separated title heading', () => {
    const body = [
      '## Gli eventi',
      '',
      '### [Ginevra](/it/events/geneva/)',
      '- **2 gennaio** — Titolo',
      '',
      '### Nota interna del titolo',
      '',
      '- **Nota** — contenuto del titolo',
    ].join('\n');

    const parsed = parseEventsDigestBody2Safe(body);

    assert.ok(parsed);
    assert.equal(parsed.events.length, 1);
    assert.deepEqual(parsed.events[0].lineIndices, [3, 4, 5, 6, 7]);
  });
});
