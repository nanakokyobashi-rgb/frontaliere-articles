import { buildProfessionEvergreenTopics, buildComuneEvergreenTopics, resolveComuneCanton } from './generator/scripts/lib/evergreen-topic-generator.mjs';
import { MUNICIPALITIES } from './generator/data/municipalities';
const M: any[] = MUNICIPALITIES as any;
console.log('professions:', buildProfessionEvergreenTopics().length);
const res = M.filter(m => m?.name && resolveComuneCanton(m));
const excluded = res.filter(m => !(typeof m.distanceKm==='number' && m.distanceKm<=30));
console.log('excluded total:', excluded.length);
const byC: Record<string,number> = {};
for (const m of excluded) byC[resolveComuneCanton(m) as string] = (byC[resolveComuneCanton(m) as string]||0)+1;
console.log('excluded per canton:', byC);
console.log('top excluded by distance:', excluded.sort((a,b)=>b.distanceKm-a.distanceKm).slice(0,8).map(m=>`${m.name} ${m.distanceKm}km pop=${m.population} prov=${m.province} canton=${resolveComuneCanton(m)}`));
for (const n of ['Gaby','Rassa','Piode','Campertogno']) {
  const m = M.find(x=>x.name===n);
  console.log(n, m ? `${m.distanceKm}km pop=${m.population} prov=${m.province} canton=${resolveComuneCanton(m)}` : 'NOT FOUND');
}
// MB comuni
const mb = M.filter(m=>m.province==='MB');
console.log('MB count', mb.length, 'distanceKm range', Math.min(...mb.map(m=>m.distanceKm)), Math.max(...mb.map(m=>m.distanceKm)));
const sel = new Set(buildComuneEvergreenTopics(M as never).map((t:any)=>t.keyword));
console.log('MB selected:', mb.filter(m=>sel.has(`vivere a ${m.name} e lavorare in ${resolveComuneCanton(m)} da frontaliere`)).length, '/', mb.length);
console.log('MB cantons:', [...new Set(mb.map(m=>resolveComuneCanton(m)))]);
