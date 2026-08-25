const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const curateArticles = async () => {
  const prompt = `Du bist ein Redakteur für KI-News. Sammle die TOP 10 wichtigsten und aktuellsten Nachrichten aus den letzten 24-48 Stunden zu:
- Künstliche Intelligenz (allgemein)
- Anthropic / Claude
- OpenAI / ChatGPT
- Google DeepMind
- EU AI Act / Regulierung

FOKUS: Internationale Meldungen mit europäischem Schwerpunkt

Antworte NUR mit validem JSON in exakt diesem Format, ohne Markdown-Codeblöcke, ohne Erklärungen davor oder danach:

{"articles":[{"headline":"Kurze Schlagzeile","summary":"Ein bis zwei Sätze Zusammenfassung","content":"Ausführlicher Absatz mit Hintergrund und Details","conclusion":"Kurzes fachliches Fazit","source":"Quellenname","date":"TT.MM.YYYY","category":"Kategoriename"}]}

Genau 10 Artikel. Wichtig: Escape alle Anführungszeichen innerhalb der Strings korrekt mit Backslash.`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 6000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    console.log("Raw response length:", text.length);
    console.log("First 200 chars:", text.substring(0, 200));

    // Robusteres JSON-Parsing
    let jsonText = text.trim();
    
    // Entferne Markdown-Codeblöcke falls vorhanden
    jsonText = jsonText.replace(/```json\s*/g, "").replace(/```\s*/g, "");
    
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    
    if (start === -1 || end === -1) {
      console.error("No JSON braces found");
      return { articles: [], error: "No JSON found in response" };
    }

    jsonText = jsonText.slice(start, end + 1);

    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (parseErr) {
      console.error("JSON Parse failed:", parseErr.message);
      console.error("Attempted to parse:", jsonText.substring(0, 500));
      return { articles: [], error: "JSON parse failed: " + parseErr.message };
    }

    if (!data.articles || !Array.isArray(data.articles)) {
      console.error("No articles array in parsed data");
      return { articles: [], error: "Invalid structure" };
    }

    return data;
  } catch (e) {
    console.error("Claude API Error:", e.message);
    return { articles: [], error: e.message };
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
        debug: data.error || null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message, articles: [] });
    }
  } else {
    res.status(404).json({ error: "Not found" });
  }
};
