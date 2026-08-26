const Parser = require("rss-parser");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");

const parser = new Parser({
  timeout: 8000,
  customFields: {
    item: [["content:encoded", "contentEncoded"]],
  },
});

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

// Wandelt HTML in Absätze um (ein \n pro Absatz), statt alles zu einer Zeile zu verschmelzen
function cleanParagraphs(html) {
  if (!html) return "";
  let text = html
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return text;
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
    const truncated = text.slice(0, 480);
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

// Holt die Original-Artikelseite und extrahiert den vollständigen Lesetext
// (dieselbe Technik, die auch Firefox für den Lesemodus nutzt) – komplett kostenlos
async function fetchFullArticleText(url) {
  if (!url) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;

    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const parsed = reader.parse();

    if (!parsed || !parsed.content) return null;
    const text = cleanParagraphs(parsed.content);
    return text.length > 200 ? text.slice(0, 6000) : null;
  } catch (e) {
    clearTimeout(timeoutId);
    return null;
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
          content: cleanText(item.contentEncoded || item.content || item.contentSnippet || item.summary || "").slice(0, 2000),
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

  // Für jeden Artikel parallel: Volltext von der Originalseite holen + Schlagzeile/Summary übersetzen
  await Promise.all(
    items.map(async (item) => {
      const [fullText, headlineDe, summaryDe] = await Promise.all([
        fetchFullArticleText(item.link).catch(() => null),
        translateText(item.headline),
        translateText(item.summary),
      ]);

      if (fullText) {
        item.content = fullText; // Volltext ersetzt den kurzen RSS-Teaser
      }
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
