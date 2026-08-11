#!/usr/bin/env bash
# retry-cmd.sh — ritenta un comando QUALUNQUE. Fratello generico di
# `scripts/lib/npm-ci-retry.sh`, che copre solo `npm ci`.
#
#   run: bash scripts/ci/retry-cmd.sh npx -y tsx@4 scripts/build-api.mjs
#   run: bash scripts/ci/retry-cmd.sh npm install --no-save esbuild@0.25.12
#
# ── Perche' esiste, dato che npm-ci-retry.sh esiste gia' (issue #98) ─────────
#
# La PR #91 ha messo il retry sui 9 punti con `npm ci` letterale. Restano
# scoperti i punti che `npm ci` non sono, e il piu' caro e' in questo file:
#
#   .github/workflows/publish-api.yml → npx -y tsx@4 scripts/build-api.mjs
#
# `npx -y` scarica tsx dal registro a ogni run. Li' un ETIMEDOUT non costa un
# articolo: costa la pubblicazione dell'INTERA superficie dati — manifest,
# articles.json, slugs.json, le due sitemap blog, i dieci feed RSS, il ticker.
#
# MISURATO (2026-08-09): `publish-api.yml` ha 40 run su 40 riuscite, quindi il
# rischio non e' ancora materializzato. E' l'unico punto in cui un blip di rete
# costa la superficie pubblica invece di un articolo, ed e' per questo che vale
# la pena coprirlo prima e non dopo.
#
# ── La retry NON e' sempre corretta: e' il CHIAMANTE a doverlo sapere ────────
#
# `npm-ci-retry.sh` puo' ritentare alla cieca per una ragione precisa e scritta:
# `npm ci` cancella `node_modules` da solo prima di ogni run, quindi un
# tentativo interrotto non lascia stato che avveleni il successivo. Non varrebbe
# per `npm install`, che muta il lockfile.
#
# Questo wrapper e' generico e quella garanzia NON puo' darla. Ogni call-site
# deve giustificare la propria idempotenza, e le due di oggi lo fanno:
#
#   - `npx -y tsx@4 scripts/build-api.mjs` — build-api.mjs fa
#     `fs.rmSync(OUT, { recursive: true, force: true })` sulla propria cartella
#     di output alla riga 71, prima di scrivere qualunque cosa. E' esattamente
#     la proprieta' che rende sicuro ritentare `npm ci`: un tentativo a meta'
#     non puo' lasciare un `dist/api/` misto. VERIFICATO leggendo il sorgente,
#     non dedotto.
#   - `npm install ... esbuild@<pin>` in una directory usa-e-getta sotto
#     RUNNER_TEMP, che nessun altro step legge o scrive.
#   - `npx -y tsx@4 --test 'host/tests/*.test.mjs'` in generator-ci.yml — i due
#     test del SiteShellContract sono di sola lettura: leggono
#     `host/shell-contract-fingerprint.json` e
#     `host/tests/shell-contract-functions.golden.json`, importano
#     `host/siteShellBootstrap.ts` e asseriscono. L'unico ramo che scrive e'
#     `--record` in shell-contract-functions.test.mjs, che richiede il flag
#     esplicito e qui non viene passato; il `new WriteCollector(...)` della
#     probe punta a `/tmp/nonexistent-probe` e non viene mai flushato.
#     VERIFICATO leggendo i due sorgenti. Un tentativo interrotto non lascia
#     stato che il successivo possa leggere.
#
# Se aggiungi un call-site, scrivi qui perche' ritentarlo e' sicuro. Un wrapper
# di retry applicato a un comando non idempotente non ripara un guasto: ne
# fabbrica uno nuovo e piu' difficile da leggere.
#
# ── Cosa NON fa ─────────────────────────────────────────────────────────────
#
# Non trasforma un guasto vero in un successo. Esaurite le attempt esce 1 —
# quello e' il punto: un wrapper che ingoia un fallimento reale e' peggio di
# nessun wrapper. E non elimina la dipendenza dalla rete, la accorcia soltanto;
# la mitigazione strutturale e' la cache npm (`cache: 'npm'` sul setup-node) e,
# per il classe di guasto fuori registro, le chiavi in `.npmrc`.
set -euo pipefail

# Stessi default di scripts/lib/npm-ci-retry.sh (3 tentativi, backoff lineare
# da 10s). `generator/tests/retry-cmd.test.mjs` verifica che i due non
# divergano: due meccanismi con due cadenze diverse sarebbero peggio di uno.
ATTEMPTS="${RETRY_CMD_ATTEMPTS:-3}"
BACKOFF_STEP="${RETRY_CMD_BACKOFF:-10}"

# Un wrapper senza comando eseguirebbe `"$@"` vuoto, che in bash e' un no-op con
# stato 0: il modo piu' economico di scrivere un falso verde. Una `run:` con una
# variabile non espansa arriverebbe esattamente cosi'.
if [ "$#" -eq 0 ]; then
  echo "::error::retry-cmd.sh chiamato senza comando da eseguire. Uscita 2: senza questa guardia sarebbe un successo silenzioso." >&2
  exit 2
fi

attempt=1
while true; do
  if "$@"; then
    if [ "$attempt" -gt 1 ]; then
      echo "retry-cmd: '$1' riuscito al tentativo $attempt/$ATTEMPTS"
    fi
    exit 0
  fi

  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "::error::retry-cmd: '$*' fallito dopo $ATTEMPTS tentativi. Se il log mostra ETIMEDOUT/ENETUNREACH verso il registro npm e' un blip di rete e un re-run di solito basta; se mostra un errore del comando, il retry ha solo confermato che e' deterministico."
    exit 1
  fi

  delay=$(( attempt * BACKOFF_STEP ))
  echo "::warning::retry-cmd: '$1' fallito (tentativo $attempt/$ATTEMPTS) — riprovo fra ${delay}s"
  sleep "$delay"
  attempt=$(( attempt + 1 ))
done
