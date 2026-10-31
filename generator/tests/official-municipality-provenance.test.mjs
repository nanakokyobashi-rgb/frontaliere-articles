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
  assert.match(topic.angle, /Luogo italiano: Mese \(Italia/u);
  assert.match(topic.angle, /Destinazione lavorativa: Grigioni/u);
  assert.doesNotMatch(topic.angle, /resid|comun/iu, 'l\'angle non deve attivare la famiglia residenza-comune');
  assert.match(topic.angle, new RegExp(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.italy.authority, 'u'));
  assert.match(topic.angle, new RegExp(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.switzerland.authority, 'u'));
});

test('le fonti di nomenclatura sono ufficiali e stabili', () => {
  assert.equal(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.italy.authority, 'ISTAT');
  assert.equal(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.switzerland.authority, 'UST');
  assert.match(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.italy.url, /^https:\/\/www\.istat\.it\//u);
  assert.match(OFFICIAL_MUNICIPALITY_REGISTRY_SOURCES.switzerland.url, /^https:\/\/statistik\.admin\.ch\//u);
});
