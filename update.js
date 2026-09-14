// Proxy serverless su Vercel: riceve dal frontend lo stesso "payload" che prima
// andava ad Anthropic ({ model, max_tokens, messages, tools }), lo gira a Gemini
// con il tool di Google Search, e restituisce la risposta incapsulata nella
// STESSA FORMA che il frontend si aspettava da Anthropic:
//   { content: [ { type: 'text', text: '...' } ] }
// così il resto del codice (parsing del JSON, retry, ecc.) non ha dovuto cambiare.
//
// La API key Gemini vive SOLO qui (variabile d'ambiente su Vercel), mai nel browser.

export default async function handler(req, res) {
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
  const maxOutputTokens = Math.max(256, Math.min(Number(max_tokens) || 4000, 8192));

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
          generationConfig: { maxOutputTokens, temperature: 0.4 }
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

    if (!text.trim()) {
      // Risposta bloccata da safety filter, MAX_TOKENS raggiunto senza testo, ecc.
      const reason = candidate && candidate.finishReason;
      res.status(502).json({ error: `Risposta vuota da Gemini${reason ? ' (finishReason: ' + reason + ')' : ''}` });
      return;
    }

    res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
}
