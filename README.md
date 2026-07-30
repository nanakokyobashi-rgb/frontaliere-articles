# frontaliere-articles

Corpus e motore di render della sezione articoli di **frontaliereticino.ch**.

Questo repo possiede gli articoli. Il sito che li renderizza vive in un repo
separato e li consuma **come dati, via HTTP** — non importa mai questi sorgenti
al momento della build. È quel confine a permettere ai due repo di seguire
strade distinte: un articolo atterra qui ed è disponibile ai consumer senza che
il sito faccia un deploy.

## La superficie pubblica

Ogni push su `main` che tocca `content/` ripubblica il set completo su GitHub
Pages, sotto `dist/api/`:

| File | Contenuto |
|---|---|
| `manifest.json` | commit, `generatedAt`, conteggi, dimensione di ogni file |
| `articles.json` | registro frontaliere (`ARTICLES`) |
| `swiss-articles.json` | registro svizzera (`SWISS_ARTICLES`) |
| `meta-<locale>.json` | titolo / excerpt / imageAlt per articolo, frontaliere |
| `meta-ch-<locale>.json` | idem, svizzera |
| `slugs.json` | mappa id → slug per locale, più la mappa inversa |

Locali: `it`, `en`, `de`, `fr`.

Il consumer dovrebbe leggere `manifest.json` per primo: `commit` identifica
esattamente lo stato del corpus, e `counts` permette di rifiutare un set
troncato prima di usarlo.

## Perché JSON e non un modulo

L'accoppiamento precedente spediva il registro come modulo ES prodotto da
Rollup. Poiché il modulo era importato sia staticamente sia dinamicamente,
Rollup emetteva un export namespace generato e riscriveva il sito dinamico in
`.then(m => m.blogArticlesData)`. Quando lo stesso sorgente è stato ripubblicato
fuori build come bundle esbuild standalone, quel bundle esportava solo
`ARTICLES`: il pick risolveva a `undefined`, il guard sollevava un `TypeError`
che scavalcava il recovery dei chunk, e **ogni pagina articolo del sito è
rimasta sullo skeleton di caricamento, senza un errore in console**.

Un documento JSON non ha una forma di modulo su cui essere d'accordo. Ha solo
chiavi. È il motivo per cui il contratto è questo e non un artefatto di build.

## Provenienza

Estratto verbatim da `packages/articles` del repo del sito
(`scripts/extract-articles-package.mjs`, issue #4959 Fase 6 step 4).
L'invariante è asserita a ogni run da `tests/extract-articles-package.test.ts`
nel repo di origine: l'estrazione è byte-identica al sorgente.

## Build locale

```bash
npx -y tsx@4 scripts/build-api.mjs   # scrive dist/api/
```

`tsx` e non `node`: i sorgenti del corpus usano specificatori relativi senza
estensione, che Node ESM puro non risolve.
