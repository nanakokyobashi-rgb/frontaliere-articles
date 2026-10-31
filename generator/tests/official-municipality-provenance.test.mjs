import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildComuneEvergreenTopics,
  OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES,
} from '../scripts/lib/evergreen-topic-generator.mjs';
import { MUNICIPALITIES } from '../data/municipalities.ts';

test('gli evergreen distinguono il comune italiano dal cantone svizzero di lavoro', () => {
  const mese = MUNICIPALITIES.find((municipality) => municipality.name === 'Mese');
  assert.ok(mese, 'Mese deve restare nel dataset dei comuni italiani di frontiera');
  assert.equal(mese.province, 'SO');

  const topic = buildComuneEvergreenTopics([mese]).find((candidate) => candidate.keyword.includes('Mese'));
  assert.ok(topic, 'Mese deve generare un candidato evergreen');
  assert.match(topic.keyword, /lavorare in Grigioni/u);
  assert.match(topic.angle, /Comune di residenza: Mese \(Italia/u);
  assert.match(topic.angle, /non è il comune di residenza/u);
  assert.match(topic.angle, new RegExp(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.italy.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(topic.angle, new RegExp(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.switzerland.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('le fonti di nomenclatura sono ufficiali e stabili', () => {
  assert.equal(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.italy.authority, 'ISTAT');
  assert.equal(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.switzerland.authority, 'UST');
  assert.match(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.italy.url, /^https:\/\/www\.istat\.it\//u);
  assert.match(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.switzerland.url, /^https:\/\/statistik\.admin\.ch\//u);
});
