// Briefing-Erstellung: RSS-Quellen lesen, filtern, entdoppeln, Volltext holen, übersetzen.
// Wird von /api/articles (App) und /api/push-dispatch (Mitteilungen) gemeinsam genutzt.

const Parser = require("rss-parser");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const {
  hasRedis, redis, redisPipeline, redisGetJson, redisSetJson, sha, decodeEntities, runInBackground,
} = require("./_lib");

const parser = new Parser({
  timeout: 8000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; DatenradarBot/1.0; +https://depesche-frontend.vercel.app)" },
  customFields: { item: [["content:encoded", "contentEncoded"]] },
});

// Kostenlose RSS-Quellen, internationale KI-News mit europäischem Schwerpunkt.
// filter:true → Feed ist nicht per URL auf KI eingegrenzt und wird inhaltlich auf KI-Bezug geprüft.
// lang:"de"   → Quelle ist bereits deutsch, wird nicht übersetzt.
// (VentureBeat ersetzt: dessen KI-Feed liefert seit Ende August 2026 nichts Neues mehr.)
const FEEDS = [
  { url: "https://tim-hilde.github.io/anthropic-rss/rss.xml", source: "Anthropic", category: "Anthropic / Claude", filter: true },
  { url: "https://openai.com/news/rss.xml", source: "OpenAI", category: "OpenAI / ChatGPT", filter: true },
  { url: "https://deepmind.google/blog/feed/basic/", source: "Google DeepMind", category: "Google DeepMind", filter: true },
  { url: "https://techcrunch.com/category/artificial-intelligence/feed/", source: "TechCrunch", category: "KI allgemein" },
  { url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", source: "The Verge", category: "KI allgemein" },
  { url: "https://www.euractiv.com/sections/digital/feed/", source: "Euractiv", category: "EU / Regulierung", filter: true },
  { url: "https://huggingface.co/blog/feed.xml", source: "Hugging Face", category: "Forschung / Open Source" },
  { url: "https://the-decoder.de/feed/", source: "The Decoder", category: "KI allgemein", lang: "de" },
];

const MAX_ARTICLES = 20;
const FRESH_MS = 20 * 60 * 1000;          // so lange gilt ein gespeichertes Briefing als aktuell
const BUILD_BUDGET_MS = 240 * 1000;       // Zeitbudget für eine Neuberechnung (Vercel-Grenze: 300 s)
const TR_TTL = 14 * 24 * 3600;            // Übersetzungen 14 Tage merken
const FT_TTL = 3 * 24 * 3600;             // extrahierte Volltexte 3 Tage merken

// ---------------------------------------------------------------------------
// Text-Aufbereitung
// ---------------------------------------------------------------------------
function cleanText(html) {
  return decodeEntities((html || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// HTML → Absätze (ein \n pro Absatz)
function cleanParagraphs(html) {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(/<\/(p|div|h[1-6]|li|blockquote|figcaption)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function formatDate(d) {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" });
}

// Grobe Spracherkennung: bereits deutsche Texte nicht übersetzen
const DE_WORDS = /\b(der|die|das|und|ist|nicht|mit|für|auf|eine?n?|sich|auch|wird|werden|bei|über|nach|zum|zur|dass|wie|oder|sind|kann)\b/gi;
const EN_WORDS = /\b(the|and|is|are|with|for|on|of|to|that|this|will|from|by|at|be|has|have|its|their|new)\b/gi;
function looksGerman(text) {
  if (!text) return false;
  const de = (text.match(DE_WORDS) || []).length;
  const en = (text.match(EN_WORDS) || []).length;
  return de >= 2 && de > en;
}

// ---------------------------------------------------------------------------
// Themenfilter und Duplikate
// ---------------------------------------------------------------------------
const AI_PATTERN = new RegExp(
  "\\b(" +
    [
      "a\\.?i", "ki", "ml", "llms?", "gpt", "genai",
      "artificial intelligence", "künstliche intelligenz",
      "machine learning", "deep learning",
      "(large language|foundation|language|ai|diffusion|reasoning) models?",
      "generative", "neural", "chatbot", "agentic", "ai agents?", "fine-?tun\\w*",
      "openai", "anthropic", "claude", "gemini", "deepmind",
      "mistral", "llama", "copilot", "hugging ?face", "ai act", "ai regulation",
    ].join("|") +
    ")\\b",
  "i"
);
function isAiRelevant(text) {
  return !!text && AI_PATTERN.test(text);
}

const STOP = new Set([
  "the","a","an","and","or","for","to","of","in","on","with","as","is","are",
  "new","how","why","what","its","their","this","that","from","by","at","be",
  "der","die","das","und","oder","für","mit","von","im","ein","eine","neue","neuer",
]);
function titleTokens(title) {
  return new Set(
    (title || "").toLowerCase().replace(/[^a-z0-9äöüß\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
  );
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
function dedupeByTitle(items, threshold = 0.6) {
  const kept = [], keptTokens = [];
  for (const item of items) {
    const tokens = titleTokens(item.headline);
    if (!keptTokens.some((t) => jaccard(tokens, t) >= threshold)) {
      kept.push(item);
      keptTokens.push(tokens);
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Sicherheit
// ---------------------------------------------------------------------------
function isSafeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return false;
    return true;
  } catch (e) {
    return false;
  }
}
function hostFrom(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return url; }
}

// ---------------------------------------------------------------------------
// Hilfen für Nebenläufigkeit
// ---------------------------------------------------------------------------
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => { active--; if (queue.length > 0) queue.shift()(); };
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      const task = () => {
        active++;
        Promise.resolve().then(fn).then((v) => { resolve(v); next(); }, (e) => { reject(e); next(); });
      };
      if (active < concurrency) task(); else queue.push(task);
    });
  };
}

async function fetchWithTimeout(url, ms, headers) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: headers || { "User-Agent": "Mozilla/5.0 (compatible; DatenradarBot/1.0)" },
    });
  } finally {
    clearTimeout(id);
  }
}

// ---------------------------------------------------------------------------
// Übersetzung (MyMemory, kostenlos) mit dauerhaftem Zwischenspeicher
// ---------------------------------------------------------------------------
const trMemory = new Map(); // schneller Zwischenspeicher innerhalb einer laufenden Instanz

async function myMemoryTranslate(text) {
  const email = process.env.MYMEMORY_EMAIL ? `&de=${encodeURIComponent(process.env.MYMEMORY_EMAIL)}` : "";
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|de${email}`;
  const res = await fetchWithTimeout(url, 15000);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (data && data.quotaFinished) {
    const err = new Error("Tageskontingent aufgebraucht");
    err.quota = true;
    throw err;
  }
  const status = Number(data && data.responseStatus);
  const out = data && data.responseData && data.responseData.translatedText;
  if (status === 200 && out && !/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) {
    return decodeEntities(out);
  }
  if (out && /MYMEMORY WARNING/i.test(out)) {
    const err = new Error("Tageskontingent aufgebraucht");
    err.quota = true;
    throw err;
  }
  throw new Error("Antwort " + status + ": " + JSON.stringify(data).slice(0, 160));
}

// Zerlegt Text in Stücke ≤ maxLen: zuerst an Absätzen, dann an Satzgrenzen, notfalls hart.
// (Vorher wurden Absätze über 480 Zeichen beim Übersetzen abgeschnitten – Text ging verloren.)
function chunkText(text, maxLen = 450) {
  const pieces = [];
  for (const line of text.split("\n")) {
    if (line.length <= maxLen) { pieces.push({ t: line, nl: true }); continue; }
    const sentences = line.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) || [line];
    let cur = "";
    const flush = () => { if (cur) { pieces.push({ t: cur.trim(), nl: false }); cur = ""; } };
    for (let s of sentences) {
      while (s.length > maxLen) {
        flush();
        const cut = s.lastIndexOf(" ", maxLen) > maxLen * 0.5 ? s.lastIndexOf(" ", maxLen) : maxLen;
        pieces.push({ t: s.slice(0, cut).trim(), nl: false });
        s = s.slice(cut);
      }
      if ((cur + s).length > maxLen) flush();
      cur += s;
    }
    flush();
    if (pieces.length) pieces[pieces.length - 1].nl = true;
  }
  // Stücke zu möglichst großen Paketen zusammenfassen
  const chunks = [];
  let cur = null;
  for (const p of pieces) {
    const sep = cur && cur.nl ? "\n" : " ";
    if (cur && (cur.t + sep + p.t).length <= maxLen) {
      cur.t += sep + p.t;
      cur.nl = p.nl;
    } else {
      if (cur) chunks.push(cur);
      cur = { t: p.t, nl: p.nl };
    }
  }
  if (cur) chunks.push(cur);
  return chunks; // [{t, nl}] – nl: danach folgt ein Absatz
}

function joinChunks(chunks, texts) {
  let out = "";
  chunks.forEach((c, i) => {
    out += texts[i];
    if (i < chunks.length - 1) out += c.nl ? "\n" : " ";
  });
  return out;
}

// Übersetzt eine Liste von Texten; nutzt Redis-/Instanz-Zwischenspeicher, hält Zeitbudget ein.
async function translateMany(texts, deadline, stats) {
  const unique = [...new Set(texts.filter((t) => t && t.length >= 2))];
  const result = new Map();
  const keyOf = (t) => "dr:tr:" + sha(t, 32);

  // 1) Instanz-Speicher
  const missing = [];
  for (const t of unique) {
    if (trMemory.has(t)) result.set(t, trMemory.get(t));
    else missing.push(t);
  }
  // 2) Redis (eine Abfrage für alle)
  if (missing.length && hasRedis()) {
    try {
      const vals = [];
      for (let i = 0; i < missing.length; i += 200) {
        vals.push(...((await redis(["MGET", ...missing.slice(i, i + 200).map(keyOf)])) || []));
      }
      missing.forEach((t, i) => {
        if (vals[i] != null) { result.set(t, vals[i]); trMemory.set(t, vals[i]); stats.cacheHits++; }
      });
    } catch (e) { console.error("Übersetzungs-Cache nicht lesbar:", e.message); }
  }
  // 3) Neu übersetzen (Reihenfolge = Priorität)
  const todo = missing.filter((t) => !result.has(t));
  const limit = createLimiter(6);
  const fresh = [];
  let quotaHit = false;
  await Promise.all(todo.map((t) => limit(async () => {
    if (quotaHit || Date.now() > deadline - 8000) { stats.skipped++; return; }
    stats.attempted++;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await myMemoryTranslate(t);
        result.set(t, out); trMemory.set(t, out); fresh.push([t, out]); stats.succeeded++;
        return;
      } catch (e) {
        stats.lastError = e.message;
        if (e.quota) { quotaHit = true; stats.quotaExhausted = true; break; }
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      }
    }
    stats.failed++;
  })));
  // 4) Neue Übersetzungen dauerhaft merken
  if (fresh.length && hasRedis()) {
    try {
      await redisPipeline(fresh.map(([t, out]) => ["SET", keyOf(t), out, "EX", String(TR_TTL)]));
    } catch (e) { console.error("Übersetzungs-Cache nicht schreibbar:", e.message); }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Volltext der Originalseite (Lesemodus-Technik), mit Zwischenspeicher
// ---------------------------------------------------------------------------
async function fetchFullArticleText(url) {
  if (!url || !isSafeUrl(url)) return null;
  try {
    const res = await fetchWithTimeout(url, 7000, {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      "Accept-Language": "en,de;q=0.8",
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (type && !/html/i.test(type)) return null;
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const parsed = new Readability(dom.window.document).parse();
    dom.window.close();
    if (!parsed || !parsed.content) return null;
    const text = cleanParagraphs(parsed.content);
    return text.length > 200 ? text.slice(0, 2800) : null;
  } catch (e) {
    return null;
  }
}

async function fullTexts(items, stats) {
  const keys = items.map((it) => "dr:ft:" + sha(it.link || it.headline, 32));
  if (!items.length) return;
  let cached = [];
  if (hasRedis()) {
    try { cached = (await redis(["MGET", ...keys])) || []; } catch (e) { cached = []; }
  }
  const writes = [];
  await Promise.all(items.map(async (item, i) => {
    if (cached[i] != null) {
      stats.fullTextCached++;
      if (cached[i]) item.content = cached[i];
      return;
    }
    const text = await fetchFullArticleText(item.link);
    stats.fullTextFetched++;
    if (text) item.content = text;
    // Auch Fehlschläge kurz merken, damit gesperrte Seiten nicht bei jedem Lauf erneut geladen werden
    writes.push(["SET", keys[i], text || "", "EX", String(text ? FT_TTL : 6 * 3600)]);
  }));
  if (writes.length && hasRedis()) {
    try { await redisPipeline(writes); } catch (e) { /* nicht kritisch */ }
  }
}

// ---------------------------------------------------------------------------
// Eigene Quellen
// ---------------------------------------------------------------------------
async function discoverFeed(inputUrl) {
  let url = (inputUrl || "").trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  if (!isSafeUrl(url)) return null;

  try {
    const feed = await parser.parseURL(url);
    if (feed) return { feedUrl: url, title: cleanText(feed.title || "") };
  } catch (e) { /* kein direkter Feed */ }

  try {
    const res = await fetchWithTimeout(url, 7000);
    if (res.ok) {
      const html = await res.text();
      const dom = new JSDOM(html, { url });
      const links = Array.from(dom.window.document.querySelectorAll('link[rel="alternate"]'));
      const feedLink =
        links.find((l) => /(rss|atom)\+xml/i.test(l.getAttribute("type") || "")) ||
        links.find((l) => /xml/i.test(l.getAttribute("type") || ""));
      const href = feedLink && feedLink.getAttribute("href") ? new URL(feedLink.getAttribute("href"), url).href : "";
      const linkTitle = feedLink ? feedLink.getAttribute("title") || "" : "";
      dom.window.close();
      if (href && isSafeUrl(href)) {
        try {
          const feed = await parser.parseURL(href);
          if (feed) return { feedUrl: href, title: cleanText(feed.title || linkTitle) };
        } catch (e) { /* weiter */ }
      }
    }
  } catch (e) { /* weiter */ }

  try {
    const origin = new URL(url).origin;
    for (const path of ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml", "/feed/", "/rss/"]) {
      try {
        const feed = await parser.parseURL(origin + path);
        if (feed && (feed.items || []).length > 0) return { feedUrl: origin + path, title: cleanText(feed.title || "") };
      } catch (e) { /* nächster Kandidat */ }
    }
  } catch (e) { /* aufgeben */ }
  return null;
}

// [{url, source, category, filter}] aus der App – nur http(s), max. 12, bereinigt
function parseCustomFeeds(raw) {
  if (!raw) return [];
  let arr = raw;
  if (typeof raw === "string") { try { arr = JSON.parse(raw); } catch (e) { return []; } }
  if (!Array.isArray(arr)) return [];
  const clean = [];
  for (const f of arr.slice(0, 12)) {
    if (!f || typeof f.url !== "string") continue;
    const url = f.url.trim();
    if (!isSafeUrl(url)) continue;
    clean.push({
      url,
      source: typeof f.source === "string" && f.source.trim() ? f.source.trim().slice(0, 40) : hostFrom(url),
      category: typeof f.category === "string" && f.category.trim() ? f.category.trim().slice(0, 40) : "Eigene Quelle",
      filter: !!f.filter,
    });
  }
  return clean;
}

// Eindeutiger Schlüssel für eine Quellen-Kombination (gleiche Quellen → gleiches gespeichertes Briefing)
function feedsKey(extraFeeds) {
  const parts = (extraFeeds || []).map((f) => `${f.url}|${f.filter ? 1 : 0}|${f.source}|${f.category}`).sort();
  return "dr:brief:" + sha(JSON.stringify(parts), 20);
}

// ---------------------------------------------------------------------------
// Briefing berechnen
// ---------------------------------------------------------------------------
async function buildBriefing(extraFeeds, budgetMs = BUILD_BUDGET_MS) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const stats = {
    collected: 0, droppedByFilter: 0, duplicatesRemoved: 0, returned: 0, customFeeds: (extraFeeds || []).length,
    failedFeeds: [], fullTextFetched: 0, fullTextCached: 0, fullTextTranslated: 0, germanSkipped: 0,
  };
  const trStats = { attempted: 0, succeeded: 0, failed: 0, skipped: 0, cacheHits: 0, quotaExhausted: false, lastError: null };

  const allFeeds = FEEDS.concat(extraFeeds || []);
  const results = await Promise.allSettled(allFeeds.map((f) => parser.parseURL(f.url)));
  let items = [];

  results.forEach((r, i) => {
    const feedMeta = allFeeds[i];
    if (r.status !== "fulfilled") {
      stats.failedFeeds.push(feedMeta.source);
      console.error("Feed fehlgeschlagen:", feedMeta.url, r.reason && r.reason.message);
      return;
    }
    (r.value.items || []).slice(0, 6).forEach((item) => {
      const rawDate = item.isoDate || item.pubDate || "";
      const headline = cleanText(item.title || "Ohne Titel");
      const summary = cleanText(item.contentSnippet || item.summary || "").slice(0, 220);
      const content = cleanText(item.contentEncoded || item.content || item.contentSnippet || item.summary || "").slice(0, 2000);
      stats.collected++;
      if (feedMeta.filter && !isAiRelevant(headline + " " + summary + " " + content)) {
        stats.droppedByFilter++;
        return;
      }
      const published = rawDate && !isNaN(new Date(rawDate)) ? new Date(rawDate).toISOString() : "";
      const link = item.link && isSafeUrl(item.link) ? item.link : "";
      items.push({
        id: sha(link || feedMeta.source + "|" + headline, 12),
        headline, summary, content,
        source: feedMeta.source,
        category: feedMeta.category,
        date: formatDate(rawDate),
        published,
        link,
        _german: feedMeta.lang === "de" || looksGerman(headline + " " + summary),
      });
    });
  });

  // Neueste zuerst; Einträge ohne Datum ans Ende
  items.sort((a, b) => (b.published ? Date.parse(b.published) : 0) - (a.published ? Date.parse(a.published) : 0));
  const before = items.length;
  items = dedupeByTitle(items);
  stats.duplicatesRemoved = before - items.length;
  items = items.slice(0, MAX_ARTICLES);
  stats.returned = items.length;

  // Volltexte (zwischengespeichert)
  await fullTexts(items, stats);

  // Übersetzen: erst alle Schlagzeilen + Kurzfassungen, dann Volltexte (neueste zuerst)
  const toTranslate = [];
  const plans = items.map((item) => {
    item.origHeadline = item.headline;
    item.origSummary = item.summary;
    if (item._german) { stats.germanSkipped++; return null; }
    toTranslate.push(item.headline, item.summary);
    return { chunks: item.content ? chunkText(item.content) : [] };
  });
  plans.forEach((p) => { if (p) p.chunks.forEach((c) => toTranslate.push(c.t)); });
  const tr = await translateMany(toTranslate, deadline, trStats);

  items.forEach((item, i) => {
    const p = plans[i];
    if (p) {
      item.headline = tr.get(item.headline) || item.headline;
      item.summary = tr.get(item.summary) || item.summary;
      if (p.chunks.length && p.chunks.every((c) => tr.has(c.t))) {
        item.content = joinChunks(p.chunks, p.chunks.map((c) => tr.get(c.t)));
        stats.fullTextTranslated++;
      }
    }
    delete item._german;
  });

  return {
    articles: items,
    lastUpdate: new Date().toISOString(),
    builtAt: Date.now(),
    buildMs: Date.now() - started,
    count: items.length,
    filterDebug: stats,
    translationDebug: trStats,
  };
}

// ---------------------------------------------------------------------------
// Gespeichertes Briefing liefern (sofort), bei Bedarf im Hintergrund erneuern
// ---------------------------------------------------------------------------
async function refreshBriefing(key, extraFeeds) {
  const lock = await redis(["SET", key + ":lock", "1", "NX", "EX", "280"]);
  if (lock !== "OK") return null; // läuft bereits
  try {
    const data = await buildBriefing(extraFeeds);
    if (data.articles.length) await redisSetJson(key, data, 7 * 24 * 3600);
    return data;
  } finally {
    await redis(["DEL", key + ":lock"]).catch(() => {});
  }
}

// mode: "swr"  → veraltet sofort liefern, im Hintergrund erneuern (für die App)
//       "sync" → veraltet: jetzt neu berechnen und warten (für den Zeitplan)
async function getBriefing(extraFeeds, { mode = "swr", force = false } = {}) {
  if (!hasRedis()) {
    const data = await buildBriefing(extraFeeds);
    return { data, state: "live" };
  }
  const key = feedsKey(extraFeeds);
  let cached = null;
  try { cached = await redisGetJson(key); } catch (e) { console.error("Briefing-Cache nicht lesbar:", e.message); }
  const age = cached ? Date.now() - (cached.builtAt || 0) : Infinity;

  if (cached && !force && age < FRESH_MS) return { data: cached, state: "fresh" };

  if (cached && !force && mode === "swr") {
    runInBackground(refreshBriefing(key, extraFeeds));
    return { data: cached, state: "stale" };
  }

  // Nichts gespeichert (oder Erneuerung gewünscht): jetzt berechnen
  const data = await refreshBriefing(key, extraFeeds).catch((e) => { console.error(e); return null; });
  if (data) return { data, state: "built" };

  // Ein anderer Aufruf rechnet gerade – auf sein Ergebnis warten (max. ~200 s)
  for (let i = 0; i < 66; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const fresh = await redisGetJson(key).catch(() => null);
    if (fresh && (!cached || fresh.builtAt > cached.builtAt)) return { data: fresh, state: "built" };
  }
  if (cached) return { data: cached, state: "stale" };
  return { data: await buildBriefing(extraFeeds), state: "live" };
}

module.exports = {
  FEEDS, getBriefing, buildBriefing, discoverFeed, parseCustomFeeds, feedsKey,
  // für Tests
  _internals: { chunkText, joinChunks, looksGerman, cleanText, cleanParagraphs, isSafeUrl, dedupeByTitle },
};
