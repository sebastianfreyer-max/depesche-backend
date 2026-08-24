// DEPESCHE Backend Server
// Läuft auf Vercel oder deinem Server
// Sammelt täglich 20 KI-Meldungen und speichert sie

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// In-Memory Storage (bei Vercel: nutze KV für Persistenz)
let cachedArticles = [];
let lastUpdate = null;

const curateArticles = async () => {
  const prompt = `Du bist ein Redakteur für KI-News. Sammle die TOP 20 wichtigsten und aktuellsten Nachrichten aus den letzten 24 Stunden zu:
- Künstliche Intelligenz (allgemein)
- Anthropic / Claude
- OpenAI / ChatGPT
- Google DeepMind
- Metall (andere KI-Labs)
- EU AI Act / Regulierung
- KI-Sicherheit

FOKUS: Internationale Meldungen mit europäischem Schwerpunkt

Gib AUSSCHLIESSLICH gültiges JSON zurück, KEINE Markdown:
{
  "articles": [
    {
      "headline": "Prägnante Schlagzeile",
      "summary": "1-2 Sätze Kurzzusammenfassung",
      "content": "2-3 Absätze detaillierte Analyse (durch Newlines getrennt)",
      "conclusion": "Dein fachliches Fazit: Was ist die Bedeutung dieser Meldung?",
      "source": "Quelle/Zeitung",
      "date": "TT.MM.YYYY",
      "category": "KI-Sicherheit" oder "Anthropic" oder "Regulierung" etc.
    },
    ...
  ]
}

WICHTIG:
- Genau 20 Artikel
- Verschiedene Quellen und Kategorien
- Aktuelle Meldungen (heute oder gestern)
- Deutschsprachige Zusammenfassungen
- Fazit sollte kurz, prägnant und fachlich sein`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON found");

    const data = JSON.parse(text.slice(start, end + 1));
    cachedArticles = data.articles || [];
    lastUpdate = new Date().toISOString();

    console.log(`✓ ${cachedArticles.length} Meldungen aktualisiert um ${lastUpdate}`);
    return cachedArticles;
  } catch (e) {
    console.error("Fehler beim Kuratieren:", e.message);
    return cachedArticles;
  }
};

// Tägliches Update um 07:00
const scheduleDaily = () => {
  const now = new Date();
  const target = new Date();
  target.setHours(7, 0, 0, 0);

  if (now > target) target.setDate(target.getDate() + 1);

  const ms = target - now;
  console.log(`Nächstes Update in ${Math.round(ms / 1000 / 60)} Minuten`);

  setTimeout(() => {
    curateArticles();
    setInterval(curateArticles, 24 * 60 * 60 * 1000); // Täglich
  }, ms);
};

// API Endpoint
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method === "GET" && req.url === "/api/articles") {
    // Erste Nutzung: Lade Meldungen
    if (cachedArticles.length === 0) {
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
}

// Für lokale Tests / Cron:
if (process.env.NODE_ENV !== "vercel") {
  console.log("DEPESCHE Backend startet...");
  scheduleDaily();
  curateArticles(); // Sofort einmal laden
}
