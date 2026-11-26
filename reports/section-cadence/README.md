# Baseline F0

Finestra storica: **25 novembre 2026, 24 ore Europe/Zurich**. Il report M1/M3 e
gli indici pubblicati sono in [`baseline-2026-11-25.json`](./baseline-2026-11-25.json).
La copertura generation-only corretta, dopo il controllo del formato TSV reale
di Actions, è in
[`generation-recalculation-2026-11-25.json`](./generation-recalculation-2026-11-25.json).
Non usare il conteggio della precedente raccolta generation-only: interpretava
il log come TSV a quattro campi e lasciava non assegnate le righe con tre campi.

## Lettura dei gate

- **M1 — articoli verificati:** 1 nella finestra contro la soglia di 20 al
  giorno per sezione. Il manifest espone 8.039 righe, 7.443 mapping validi e
  596 mapping non risolti; il valore verificato è quindi un conteggio provato,
  non una prova che l'intero indice sia completo.
- **M2 — funnel:** usare `metrics` e `workflowCoverage` nel report generation
  corretto. Tutti i 25 workflow attesi sono inclusi e hanno copertura: 118 run
  nazionali, 4–5 per workflow cantonale. Dei run nazionali, 88 sono assegnati
  (49 frontaliere, 39 svizzera) e 30 restano globali perché saltati prima del
  job `generate`: 27 `admit-in-flight` e 3 `admit-content-backlog`. Il vecchio
  conteggio di 73 non è direttamente confrontabile perché mescolava run nella
  finestra e run vivi fuori finestra ed era basato su parsing TSV errato; il dato
  valido qui è 30 globali in finestra più 2 live globali fuori finestra. Non li
  attribuiamo a una sezione. Il report distingue
  anche 6 terminali con esito non osservabile già assegnati (2 frontaliere e 1
  ciascuno per canton-sh, canton-so, canton-tg e canton-vd), senza convertirli
  in successi o zeri.
- **M3 — pubblicazione:** 15 run, 113 commit su main e 6 violazioni di fanout
  nel report storico; il massimo osservato è 3 run per commit. La latenza
  storica al primo HTTP 200 non era osservabile: il controllo diretto della
  pagina è un'osservazione puntuale e il completamento del run è un proxy.
  Misurare la latenza commit → primo HTTP 200 dopo la modifica.
- **M4 — chiamate LLM/articolo:** il report trova 183 tentativi ammessi, tutti
  senza contatore perché i log precedono i marker al confine provider. È
  unavailable, non zero. La prima misura confrontabile richiede una finestra
  di 24–48 ore dopo il merge.
- **M5 — contesa push:** 0 esaurimenti sui 183 job di generazione avviati, con
  183 log leggibili e copertura completa; i 30 skip nazionali globali non
  avevano un job `generate` e non entrano nel denominatore. Per workflow i
  conteggi e la copertura sono nel report generation corretto.
- **M6 — duplicati semantici:** non disponibile come misura storica
  authoritative. L'indice della finestra di 90 giorni contiene 2.905 candidati,
  inclusi due articoli con data sconosciuta; il codice li conserva nell'insieme
  conservativo. Il tentativo locale non ha potuto caricare il binding nativo
  ONNX Darwin/x64 e non ha prodotto embedding. Nessun conteggio di coppie o zero
  è dichiarato. Una misura Linux compatibile deve raccogliere anche i marker
  runtime di presenza/count dello store, modello e soglia effettiva per sezione.

## Capacità e piloti

Il limite numerico del piano GitHub Actions non è leggibile con l'identità del
coordinatore configurata. Il massimo osservato e le attese sono riportati nel
file generation; nella finestra campionata sono stati osservati al massimo 3
job di generazione contemporanei e un'attesa massima di 105,17 minuti. I tre
piloti ordinati per `items7d` sono canton-basilea (606), canton-be (594) e
canton-vs (585).

## Verifica dopo il merge

Raccogliere una finestra completa di 24–48 ore Europe/Zurich dopo il merge su
tutti i 25 workflow e tutte le 26 sezioni. Il report pieno contiene M1–M5,
`generationEvidence` (marker M4/M6 e copertura per workflow), più uno snapshot
M6 con commit manifest, conteggi per sezione e candidati pubblici
`id/section/date/title/excerpt` degli ultimi 90 giorni. Lo snapshot porta un
checksum SHA-256 e viene letto dal ricalcolo Linux senza interrogare di nuovo
l'API: il corpus non può avanzare mentre il runner si avvia. Il Mac può
continuare a segnalare `MODULE_NOT_FOUND` sul binding ONNX; in quel caso M1–M5
e i marker runtime restano disponibili nel report.

Per produrre il report:

```sh
node scripts/ci/measure-section-cadence.mjs --from YYYY-MM-DD --to YYYY-MM-DD --output reports/section-cadence/postmerge-YYYY-MM-DD.json
```

Il ricalcolo M6 usa il job manuale `measure-section-cadence-m6` già aggiunto a
Generator CI. Preparare un branch temporaneo basato sul commit del report e
caricare il JSON post-merge, poi dispatchare il workflow sullo stesso branch:

```sh
bin/gh-frontaliere --identity nanako workflow run generator-ci.yml --repo nanakokyobashi-rgb/frontaliere-articles --ref <branch-con-report> -f m6_end_date=YYYY-MM-DD -f m6_generation_report=reports/section-cadence/postmerge-YYYY-MM-DD.json
```

Il runner verifica che checksum snapshot e manifest commit coincidano con il
report; rifiuta symlink e percorsi esterni al repository. Il job gira su
`ubuntu-latest`, Node 22 e `package-lock.json`, installato con
`bash scripts/lib/npm-ci-retry.sh --no-audit --no-fund`, come il job di
generazione e il dry-run di Generator CI. Usa
`@huggingface/transformers` 4.3.0, `onnxruntime-node` 1.30.0 e il modello
`Xenova/multilingual-e5-small` in fp32 a 384 dimensioni; `embeddingClient.mjs`
mantiene la stessa normalizzazione e il testo dedup `title + '\n\n' + excerpt`
tagliato a 4.000 caratteri. L'output `m6-supplement.json` viene caricato come
artifact Actions e non modifica la pubblicazione.

M6 è authoritative solo quando tutte le sezioni candidate hanno marker runtime
completi con store, modello e soglia effettiva verificati. Se nel periodo il
dedup va fail-open, il report lascia `nearDuplicatePairCount: null` e mantiene
separato `policyThresholdProxyPairCount`: il proxy usa la soglia di policy
osservata/ricostruita e non dimostra il gate runtime; non si imputa zero.

La finestra M4 post-merge è la prima comparabile perché i 183 tentativi storici
precedono la strumentazione. Anche M6 resta distinto: i due articoli con data
sconosciuta entrano nel set conservativo, e uno zero è authoritative solo se è
zero anche sull'upper bound alle soglie effettive verificate. I buchi storici
non vengono riempiti con i risultati della nuova finestra.

Comando baseline:

```sh
node scripts/ci/measure-section-cadence.mjs --from 2026-11-25 --to 2026-11-25 --output reports/section-cadence/baseline-2026-11-25.json
```
