// Proxy serverless su Vercel: riceve dal frontend lo stesso "payload" che prima
// andava ad Anthropic ({ model, max_tokens, messages, tools }), lo gira a Gemini
// con il tool di Google Search, e restituisce la risposta incapsulata nella
// STESSA FORMA che il frontend si aspettava da Anthropic:
//   { content: [ { type: 'text', text: '...' } ] }
// così il resto del codice (parsing del JSON, retry, ecc.) non ha dovuto cambiare.
//
// La API key Gemini vive SOLO qui (variabile d'ambiente su Vercel), mai nel browser.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY non configurata sul server (impostala nelle Environment Variables di Vercel)' });
    return;
  }

  const { max_tokens, messages } = req.body || {};
  const prompt = messages && messages[0] && messages[0].content;
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'Prompt mancante o non valido nel body' });
    return;
  }

  // Puoi cambiare modello qui senza toccare il frontend.
  // gemini-2.5-flash: buon compromesso costo/qualità/velocità per questo caso d'uso.
  const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  // Il frontend manda un max_tokens pensato per Anthropic (fino a 8000): con Gemini 2.5,
  // che è un modello "thinking", parte del budget di output viene consumata dal
  // ragionamento interno prima ancora di scrivere la risposta finale — con rose ampie
  // (10+ squadre) il JSON risultava troncato. Alziamo il tetto reale e limitiamo il
  // budget di pensiero, lasciando più spazio alla risposta vera e propria.
  const maxOutputTokens = Math.max(4096, Math.min((Number(max_tokens) || 4000) * 3, 32768));

  // Budget di "pensiero" per l'orchestrazione delle ricerche: con richieste grounded
  // che devono cercare e aggregare molte entità (es. xG di 20 squadre), 1024 è spesso
  // troppo stretto e il modello può terminare con finishReason STOP senza mai scrivere
  // il testo finale (bug noto di Gemini con google_search su prompt di ricerca "larghi",
  // vedi forum Google AI / googleapis/python-genai#1289). Alziamo un po' il tetto.
  const thinkingBudget = Math.min(4096, Math.max(1024, Math.round(maxOutputTokens * 0.4)));

  async function callGeminiOnce() {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: {
            maxOutputTokens,
            temperature: 0.4,
            thinkingConfig: { thinkingBudget }
          }
        })
      }
    );

    const retryAfter = upstream.headers.get('retry-after');

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      const err = new Error(`Gemini HTTP ${upstream.status}: ${errText.slice(0, 400)}`);
      err.status = upstream.status;
      err.retryAfter = retryAfter;
      throw err;
    }

    const data = await upstream.json();
    const candidate = data && data.candidates && data.candidates[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const text = parts.map(p => p.text || '').join('\n');
    const finishReason = candidate && candidate.finishReason;

    if (!text.trim()) {
      // Risposta bloccata da safety filter, o - il caso più comune - Gemini che con
      // il tool di ricerca "si perde" nell'orchestrazione delle query e chiude con
      // STOP senza mai produrre testo. È quasi sempre transitorio: chi chiama questa
      // funzione ritenta.
      const err = new Error(`Risposta vuota da Gemini${finishReason ? ' (finishReason: ' + finishReason + ')' : ''}`);
      err.emptyResponse = true;
      err.retryAfter = retryAfter;
      throw err;
    }

    if (finishReason === 'MAX_TOKENS') {
      // Testo presente ma troncato: il JSON quasi certamente non si chiude. Un retry
      // non aiuta qui (è un problema di budget, non di flakiness), meglio segnalarlo
      // subito invece di scoprirlo da un errore di parsing generico più avanti.
      const err = new Error('Risposta troncata da Gemini (finishReason: MAX_TOKENS) — la rosa/squadre da valutare è troppo ampia per il budget di token attuale. Riprova, o dividi l\'aggiornamento in più gruppi di squadre.');
      err.status = 502;
      err.retryAfter = retryAfter;
      throw err;
    }

    return { text, retryAfter };
  }

  const MAX_ATTEMPTS = 2; // 1 tentativo + 1 retry interno, solo per risposte vuote
  try {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { text, retryAfter } = await callGeminiOnce();
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        res.status(200).json({ content: [{ type: 'text', text }] });
        return;
      } catch (err) {
        lastErr = err;
        // Ritenta subito (nessun backoff: non è rate-limit) solo sul caso "risposta
        // vuota", che è tipicamente intermittente. Per tutti gli altri errori (4xx/5xx
        // espliciti, MAX_TOKENS) esce subito: un retry non cambierebbe l'esito.
        if (err.emptyResponse && attempt < MAX_ATTEMPTS) continue;
        break;
      }
    }
    if (lastErr.retryAfter) res.setHeader('Retry-After', lastErr.retryAfter);
    // Se dopo il retry interno è ancora vuota, segnaliamo 503: il frontend la tratta
    // già come transitoria e la ritenta da solo con backoff (a differenza del 502
    // usato prima, che il frontend non ritentava affatto).
    const status = lastErr.status || (lastErr.emptyResponse ? 503 : 502);
    res.status(status).json({ error: lastErr.message });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
};
