import { resolveComuneCanton } from './generator/scripts/lib/evergreen-topic-generator.mjs';
import { MUNICIPALITIES } from './generator/data/municipalities';
const M: any[] = MUNICIPALITIES as any;
const far = M.filter(m=>['BG','BS','TN','BZ'].includes(m.province));
console.log('far count', far.length);
const byC: Record<string,number> = {};
for (const m of far) { const c = resolveComuneCanton(m) ?? 'UNRESOLVED'; byC[c]=(byC[c]||0)+1; }
console.log(byC);
console.log('unresolved:', far.filter(m=>!resolveComuneCanton(m)).map(m=>m.name));
// LC comuni
const lc = M.filter(m=>m.province==='LC');
const lcC: Record<string,number> = {};
for (const m of lc) { const c = resolveComuneCanton(m) ?? 'UNRESOLVED'; lcC[c]=(lcC[c]||0)+1; }
console.log('LC rows', lc.length, lcC);
