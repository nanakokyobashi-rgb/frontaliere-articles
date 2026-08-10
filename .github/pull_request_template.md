<!--
  Il body di questa PR ha un gate deterministico: `pr-body-contract.yml`.
  Non e' burocrazia — le due sezioni sono i due input di `auto-merge-eval`, e
  `Closes` e' l'unica cosa che chiude la issue al merge.

  Tre trappole misurate, tutte e tre gia' costate un ciclo di review:

  1. La sezione si chiude al PRIMO heading di qualunque livello. Un `###`
     subito sotto `## Implementato` la lascia VUOTA e il gate fallisce in 15
     secondi. Bullet sostanziosi PRIMA di qualunque sottosezione.

  2. Su questo repo l'header e' `## Non implementato (ancora)`, CON «(ancora)».
     Sul sito (`frontaliere-si-o-no`) e' senza. Copiare un body dall'uno
     all'altro fa fallire `contract`.

  3. `Closes #N` va scritto in INGLESE. GitHub riconosce solo
     close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved.
     «Chiude #133» e' prosa: il link non viene creato e la issue resta aperta
     con la fix gia' su main (successo reale: PR #139 / issue #133).
     Una keyword per issue, una per riga: `Closes #12 #34` chiude solo #12.
-->

## Implementato

- 

## Non implementato (ancora)

<!--
  Ogni voce e' lavoro ancora DOVUTO, quindi ognuna vuole uno stato concreto:

      **Stato:** `in questa PR` | `PR concatenata #N` | `blocked: <causa esterna reale>`

  Non valgono come stato: «out of scope», «posposto», «vale un giro dedicato»,
  «separatamente», «prima o poi». Sono le scappatoie che REVIEW.md §98 esclude,
  e il gate le rifiuta.

  Se il task e' completo, cancella i bullet e scrivi una riga sola: Nessuno
-->

- 

Closes #
