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

  try {
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
            thinkingConfig: { thinkingBudget: 1024 }
          }
        })
      }
    );

    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) res.setHeader('Retry-After', retryAfter);

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      res.status(upstream.status).json({ error: `Gemini HTTP ${upstream.status}: ${errText.slice(0, 400)}` });
      return;
    }

    const data = await upstream.json();
    const candidate = data && data.candidates && data.candidates[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const text = parts.map(p => p.text || '').join('\n');
    const finishReason = candidate && candidate.finishReason;

    if (!text.trim()) {
      // Risposta bloccata da safety filter, MAX_TOKENS raggiunto senza testo, ecc.
      res.status(502).json({ error: `Risposta vuota da Gemini${finishReason ? ' (finishReason: ' + finishReason + ')' : ''}` });
      return;
    }

    if (finishReason === 'MAX_TOKENS') {
      // Testo presente ma troncato: il JSON quasi certamente non si chiude. Meglio
      // segnalarlo chiaramente ora che scoprirlo dopo da un errore di parsing generico.
      res.status(502).json({ error: 'Risposta troncata da Gemini (finishReason: MAX_TOKENS) — la rosa/squadre da valutare è troppo ampia per il budget di token attuale. Riprova, o dividi l\'aggiornamento in più gruppi di squadre.' });
      return;
    }

    res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
};
