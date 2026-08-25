/**
 * create-article-sigterm-checkpoint.test.mjs — issue #525
 *
 * `generate-article.yml` uccide il generatore con
 * `timeout --signal=TERM --kill-after=60s "${cap}s"`: SIGTERM prima, SIGKILL 60
 * secondi dopo. Fino a #525 `create-article.mjs` non aveva NESSUN
 * `process.on(...)` proprio (misurato: zero match nel file), quindi valeva
 * l'azione di default di Node — terminare subito — e i 60 secondi di grazia che
 * il workflow compra apposta non servivano a niente. Il kill arrivava anche
 * MUTO: nel report della run non restava la ragione, e una sezione persa per il
 * cap sembrava identica a una persa per un provider giu'.
 *
 * Cosa questo test NON difende: l'atomicita' della scrittura. Quella e' gia'
 * chiusa da #561 (temp + `renameSync`) ed e' difesa da
 * `create-article-write-atomic.test.mjs`. E' anche il motivo per cui l'handler
 * qui e' un FLAG e non una routine di salvataggio: lavorare dentro un signal
 * handler correrebbe contro il flush che #561 ha reso atomico.
 *
 * Forma del test: by-construction sul sorgente, come il gemello write-atomic e
 * per la stessa ragione — importare il modulo esegue `main()`, e gli helper
 * (`wallBudgetExceeded`, `requestCooperativeStop`) non sono esportati. Cio' che
 * conta e' la FORMA del checkpoint, e sono quattro proprieta' portanti: se una
 * sparisce, il difetto di #525 torna in silenzio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FILE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');
const SRC = fs.readFileSync(FILE, 'utf-8');

/** Solo le righe eseguibili: i commenti CITANO il difetto per esteso, e un
 *  match sul testo grezzo li leggerebbe come codice. Stesso taglio che usa
 *  auto-merge-orphan-push.test.mjs. */
const ATTIVO = SRC.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

test('#525: il generatore registra un handler SIGTERM (era zero)', () => {
  assert.match(ATTIVO, /process\.on\(\s*'SIGTERM'/,
    'senza handler vale il default di Node: morte immediata, i 60s di --kill-after sprecati');
  assert.match(ATTIVO, /process\.on\(\s*'SIGINT'/,
    'il Ctrl-C locale deve seguire la stessa strada del kill di CI, o il comportamento diverge fra i due ambienti');
});

test('#525: la registrazione sta a module scope, non dentro una funzione', () => {
  // Load-bearing: ai-models.mjs arma il PROPRIO hook SIGTERM pigramente (alla
  // prima persistenza dei punteggi) e quell'hook esce `process.exit(143)` dopo
  // un flush async. Node esegue i listener in ordine di registrazione: questo,
  // sincrono e registrato all'import, arma il flag PRIMA che l'altro possa
  // chiudere il processo. A registrazioni invertite il flag verrebbe armato
  // dopo che al processo e' gia' stato detto di uscire.
  const riga = SRC.split('\n').findIndex((l) => /^process\.on\(\s*'SIGTERM'/.test(l));
  assert.ok(riga >= 0, "atteso `process.on('SIGTERM'` in colonna 0 (module scope), non indentato dentro una funzione");
});

test('#525: il flag entra in wallBudgetExceeded(), che e\' gia\' pollato ovunque', () => {
  // E' tutto il meccanismo: il loop di generazione interroga gia'
  // wallBudgetExceeded() in una dozzina di punti (tentativi topic, retry body2,
  // slot di discovery, pre-scan evergreen). Armare il flag trasforma ognuno di
  // quei poll in un punto di uscita, e il processo esce dalla propria strada
  // DICHIARATA — la stessa del budget scaduto. Nessun nuovo exit path.
  const corpo = ATTIVO.slice(ATTIVO.indexOf('function wallBudgetExceeded'));
  const fine = corpo.indexOf('\n}');
  assert.ok(fine > 0, 'atteso di trovare il corpo di wallBudgetExceeded()');
  assert.match(corpo.slice(0, fine), /_sigtermStopRequested/,
    'il flag deve essere letto qui: e\' il solo punto gia' + "' pollato dal loop");

  // ...e deve essere in OR, non in AND: un SIGTERM ferma il processo ANCHE se
  // il budget di wall clock non e' scaduto (e' il caso normale — il kill
  // arriva proprio perche' il cap di sezione e' piu' stretto del budget).
  assert.match(corpo.slice(0, fine), /_sigtermStopRequested\s*\|\|/,
    'in AND il flag non fermerebbe niente finche\' il budget ha tempo residuo');
});

test('#525: esiste un\'uscita forzata bounded, o l\'handler ALLUNGA la vita del processo', () => {
  // Trappola vera, non teorica: registrare un listener SIGTERM disattiva
  // l'azione di default di Node. Se il segnale arriva mentre il processo e'
  // dentro una chiamata provider lunga (il tetto di ai-models.mjs e' 600s),
  // nessun poll viene raggiunto e il processo sopravvive fino al SIGKILL —
  // cioe' la finestra cooperativa avrebbe peggiorato la cosa che doveva
  // migliorare.
  assert.match(ATTIVO, /COOPERATIVE_STOP_GRACE_MS/);
  assert.match(ATTIVO, /process\.exit\(143\)/,
    '143 = 128 + SIGTERM: il codice che il chiamante gia\' si aspetta da un kill per segnale');
  assert.match(ATTIVO, /\.unref\(\)/,
    'senza unref il timer terrebbe vivo l\'event loop e una run sana finirebbe per aspettarlo');

  const m = ATTIVO.match(/COOPERATIVE_STOP_GRACE_MS\s*=\s*([\d_]+)/);
  assert.ok(m, 'atteso un valore letterale per la grazia cooperativa');
  const graceMs = Number(m[1].replace(/_/g, ''));
  assert.ok(graceMs > 0 && graceMs < 60_000,
    `la grazia (${graceMs}ms) deve stare DENTRO il --kill-after=60s di generate-article.yml: al secondo esatto ci pensa il SIGKILL, e l'uscita dichiarata non arriva mai`);
});

test('#525: la fermata e\' DICHIARATA, non muta', () => {
  // Un kill che non stampa niente e' indistinguibile da un crash — e' meta'
  // del difetto riportato in #525, non un dettaglio di log.
  assert.match(ATTIVO, /::warning::create-article\.mjs: ricevuto/);
  assert.ok(!/::error::create-article\.mjs: ricevuto/.test(ATTIVO),
    'una fermata voluta non e\' un errore: ::error qui produrrebbe un rosso di CI che nessun fix puo\' chiudere (stessa classe di #170)');
});

test('#525: l\'handler resta idempotente — due SIGTERM non raddoppiano l\'uscita', () => {
  const corpo = ATTIVO.slice(ATTIVO.indexOf('function requestCooperativeStop'));
  const fine = corpo.indexOf('\n}');
  assert.match(corpo.slice(0, fine), /if\s*\(_sigtermStopRequested\)\s*return/,
    'senza guardia, un secondo segnale armerebbe un secondo timer di uscita forzata e ri-loggherebbe');
});
