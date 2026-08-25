const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const curateArticles = async () => {
  const prompt = `Du bist ein Redakteur für KI-News. Sammle die TOP 20 wichtigsten und aktuellsten Nachrichten aus den letzten 24 Stunden zu:
- Künstliche Intelligenz (allgemein)
- Anthropic / Claude
- OpenAI / ChatGPT
- Google DeepMind
- Andere KI-Labs
- EU AI Act / Regulierung
- KI-Sicherheit

FOKUS: Internationale Meldungen mit europäischem Schwerpunkt

Gib AUSSCHLIESSLICH gültiges JSON zurück, KEINE Markdown:
{"articles":[{"headline":"Schlagzeile","summary":"1-2 Sätze","content":"Analyse","conclusion":"Fazit","source":"Quelle","date":"TT.MM.YYYY","category":"Kategorie"}]}

Genau 20 Artikel.`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return { articles: [] };
    }

    const data = JSON.parse(text.slice(start, end + 1));
    return data;
  } catch (e) {
    console.error("Claude API Error:", e.message);
    return { articles: [] };
  }
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method === "GET") {
    try {
      const data = await curateArticles();
      res.status(200).json({
        articles: data.articles || [],
        lastUpdate: new Date().toISOString(),
        count: (data.articles || []).length,
      });
    } catch (e) {
      res.status(500).json({ error: e.message, articles: [] });
    }
  } else {
    res.status(404).json({ error: "Not found" });
  }
};
