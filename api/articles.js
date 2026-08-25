const Parser = require("rss-parser");
const parser = new Parser({ timeout: 8000 });

// Kostenlose RSS-Quellen, internationale KI-News mit europäischem Schwerpunkt
const FEEDS = [
  { url: "https://tim-hilde.github.io/anthropic-rss/rss.xml", source: "Anthropic", category: "Anthropic / Claude" },
  { url: "https://openai.com/news/rss.xml", source: "OpenAI", category: "OpenAI / ChatGPT" },
  { url: "https://deepmind.google/blog/feed/basic/", source: "Google DeepMind", category: "Google DeepMind" },
  { url: "https://techcrunch.com/category/artificial-intelligence/feed/", source: "TechCrunch", category: "KI allgemein" },
  { url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", source: "The Verge", category: "KI allgemein" },
  { url: "https://www.euractiv.com/sections/digital/feed/", source: "Euractiv", category: "EU / Regulierung" },
  { url: "https://huggingface.co/blog/feed.xml", source: "Hugging Face", category: "Forschung / Open Source" },
  { url: "https://venturebeat.com/category/ai/feed/", source: "VentureBeat", category: "KI allgemein" },
];

function cleanText(html) {
  return (html || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDate(d) {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// Kostenlose Übersetzung über MyMemory (kein API-Key nötig, Fair-Use-Limit)
async function translateText(text) {
  if (!text || text.length < 2) return text;
  try {
    const truncated = text.slice(0, 480); // MyMemory-Limit pro Anfrage
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(truncated)}&langpair=en|de`;
    const res = await fetch(url);
    if (!res.ok) return text;
    const data = await res.json();
    const translated = data && data.responseData && data.responseData.translatedText;
    if (translated && translated.length > 0 && !translated.toUpperCase().includes("MYMEMORY WARNING")) {
      return translated;
    }
    return text;
  } catch (e) {
    return text;
  }
}

async function fetchAllFeeds() {
  const results = await Promise.allSettled(FEEDS.map((f) => parser.parseURL(f.url)));
  let items = [];

  results.forEach((r, i) => {
    const feedMeta = FEEDS[i];
    if (r.status === "fulfilled") {
      (r.value.items || []).slice(0, 6).forEach((item) => {
        const rawDate = item.isoDate || item.pubDate || "";
        items.push({
          headline: cleanText(item.title || "Ohne Titel"),
          summary: cleanText(item.contentSnippet || item.summary || "").slice(0, 220),
          content: cleanText(item.content || item.contentSnippet || item.summary || "").slice(0, 1500),
          source: feedMeta.source,
          category: feedMeta.category,
          date: formatDate(rawDate),
          link: item.link || "",
          _sortDate: rawDate,
        });
      });
    } else {
      console.error("Feed fehlgeschlagen:", feedMeta.url, r.reason && r.reason.message);
    }
  });

  items.sort((a, b) => new Date(b._sortDate) - new Date(a._sortDate));
  items = items.slice(0, 20);
  items.forEach((it) => delete it._sortDate);

  // Schlagzeile + Zusammenfassung ins Deutsche übersetzen (kostenlos, parallel)
  await Promise.all(
    items.map(async (item) => {
      const [headlineDe, summaryDe] = await Promise.all([
        translateText(item.headline),
        translateText(item.summary),
      ]);
      item.headline = headlineDe;
      item.summary = summaryDe;
    })
  );

  return items;
}

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
      const articles = await fetchAllFeeds();
      res.status(200).json({
        articles,
        lastUpdate: new Date().toISOString(),
        count: articles.length,
      });
    } catch (e) {
      res.status(500).json({ error: e.message, articles: [] });
    }
  } else {
    res.status(404).json({ error: "Not found" });
  }
};
