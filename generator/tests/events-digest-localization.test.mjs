import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findArticleLocalizedToponymMismatches } from '../scripts/lib/localized-toponyms.mjs';
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

  it('does not repair body2 when event structure cannot be paired and keeps the gate fail-closed', () => {
    const original = incidentArticle();
    original.content.en.body2 = 'Zürich';

    const repaired = repairEventsDigestLocalizedToponyms(original);

    assert.equal(repaired.content.en.body2, 'Zürich');
    assert.ok(findArticleLocalizedToponymMismatches(repaired).some(({ locale, code, type }) => (
      locale === 'en' && code === 'BODY2' && type === 'structure'
    )));
  });
});
