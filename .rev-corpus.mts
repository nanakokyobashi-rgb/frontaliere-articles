import { buildComuneEvergreenTopics, resolveComuneCanton } from './generator/scripts/lib/evergreen-topic-generator.mjs';
import { MUNICIPALITIES } from './generator/data/municipalities';
const M: any[] = MUNICIPALITIES as any;
console.log('rows', M.length);
const byC: Record<string, any[]> = {};
let unresolved = 0;
for (const m of M) {
  const c = resolveComuneCanton(m);
  if (!c || !m?.name) { unresolved++; continue; }
  (byC[c] ||= []).push(m);
}
console.log('unresolved/no-name', unresolved);
let totalRes = 0;
for (const [c, l] of Object.entries(byC)) {
  totalRes += l.length;
  const sel = l.filter((m:any)=> typeof m.distanceKm==='number' && m.distanceKm<=30);
  console.log(c, 'total', l.length, 'sel<=30', sel.length, 'non-number', l.filter((m:any)=>typeof m.distanceKm!=='number').length);
}
console.log('resolved total', totalRes);
const computed = buildComuneEvergreenTopics(M as never);
console.log('computed total', computed.length);
// radius table check
for (const r of [20,25,30,35,40,1e9]) {
  const per: Record<string,number> = {};
  let t=0;
  for (const [c,l] of Object.entries(byC)) { const n=l.filter((m:any)=>typeof m.distanceKm==='number'&&m.distanceKm<=r).length; per[c]=n; t+=n; }
  console.log('radius', r, JSON.stringify(per), 'total', t);
}
