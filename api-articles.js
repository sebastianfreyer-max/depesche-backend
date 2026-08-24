import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

let cachedArticles = [];
let lastUpdate = null;

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
{
  "articles": [
    {
      "headline": "Prägnante Schlagzeile",
      "summary": "1-2 Sätze Kurzzusammenfassung",
      "content": "2-3 Absätze detaillierte Analyse",
      "conclusion": "Fachliches Fazit",
      "source": "Quelle",
      "date": "TT.MM.YYYY",
      "category": "Kategorie"
    }
  ]
}

Genau 20 Artikel mit verschiedenen Quellen.`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON");

    const data = JSON.parse(text.slice(start, end + 1));
    cachedArticles = data.articles || [];
    lastUpdate = new Date().toISOString();
    console.log(`✓ ${cachedArticles.length} Artikel aktualisiert`);
  } catch (e) {
    console.error("Fehler:", e.message);
  }
};

// Beim Start einmalig laden
if (cachedArticles.length === 0) {
  await curateArticles();
}

export default async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method === "GET") {
    // Bei jedem Request checken, ob Update nötig (täglich)
    const now = new Date();
    if (!lastUpdate || now.getHours() === 7) {
      await curateArticles();
    }

    res.status(200).json({
      articles: cachedArticles,
      lastUpdate,
      count: cachedArticles.length,
    });
  } else {
    res.status(404).json({ error: "Not found" });
  }
};
