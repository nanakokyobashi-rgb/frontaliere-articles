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

Eseguire lo stesso strumento su un runner Linux con dipendenze runtime
compatibili, su 24–48 ore Europe/Zurich, includendo tutti i 25 workflow e tutte
le 26 sezioni. Verificare per sezione copertura dei log, contatori M4, marker
dedup M6 e soglie osservate; poi confrontare articoli M1, code M2, fanout e
latenza M3, esaurimenti M5 e coppie M6. I buchi del periodo pre-strumentazione
restano distinti dalla nuova finestra post-merge.

Comando baseline:

```sh
node scripts/ci/measure-section-cadence.mjs --from 2026-11-25 --to 2026-11-25 --output reports/section-cadence/baseline-2026-11-25.json
```
