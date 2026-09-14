# Fantacalcio — Gestione Rosa (indipendente, con Gemini)

App statica (`index.html`) + una funzione serverless (`api/update.js`) che fa da
proxy verso l'API Gemini di Google. La chiave API resta **solo sul server**
(variabile d'ambiente), mai nel browser: l'app è quindi sicura da pubblicare
pubblicamente su GitHub anche con il repo visibile a tutti.

## Come funziona

- `index.html` è tutta l'app (rosa, formazione, calcolo punteggio atteso, ecc.) — identica a prima, tranne la chiamata AI che ora punta a `/api/update` invece che direttamente ad Anthropic.
- `api/update.js` riceve la richiesta dal browser, la gira a Gemini con il tool "Google Search" attivo (per cercare titolarità, ballottaggi, infortuni, xG/xGA aggiornati), e rimanda al browser solo il testo generato.
- Nessuna API key viaggia mai lato client.

## Deploy in 5 minuti

1. **Crea una API key Gemini** (gratuita per iniziare): vai su [aistudio.google.com/apikey](https://aistudio.google.com/apikey) e generane una.
2. **Crea un repo GitHub** con questi due file (`index.html` e la cartella `api/`) — puoi anche solo trascinarli nell'interfaccia web di GitHub ("Add file → Upload files").
3. **Vai su [vercel.com](https://vercel.com)**, accedi con GitHub, "Add New → Project", seleziona il repo appena creato. Vercel riconosce automaticamente `api/update.js` come funzione serverless — non serve configurare nulla di build (è un sito statico + una function, zero framework).
4. Prima del primo deploy (o dopo, in **Project Settings → Environment Variables**), aggiungi:
   - `GEMINI_API_KEY` = la chiave creata al punto 1
5. Deploy. Il sito sarà live su `https://<nome-progetto>.vercel.app`. Apri l'app, clicca "🔎 Aggiorna con AI" — funziona da subito, senza chiedere nessuna chiave all'utente.

## Note

- **Costi**: Gemini ha una fascia gratuita generosa (vedi [ai.google.dev/pricing](https://ai.google.dev/pricing)); per l'uso di un'app fantacalcio personale (una manciata di aggiornamenti a settimana) resterai verosimilmente sempre nel piano gratuito. Se noti errori 429, è lo stesso identico problema di rate-limit già gestito nel frontend con retry/backoff automatico.
- **Cambiare modello**: imposta la env var opzionale `GEMINI_MODEL` (es. `gemini-2.5-pro` per risposte più accurate ma più lente/costose, o un modello Gemini 3 quando disponibile).
- **Dati**: la rosa, la formazione, i pesi e lo storico restano salvati nel `localStorage` del browser di chi usa l'app — non c'è un database condiviso. Ogni persona che apre il link ha la propria rosa locale.
- **Dominio personalizzato**: opzionale, si aggiunge da Vercel in "Domains" se vuoi un indirizzo diverso da `*.vercel.app`.
