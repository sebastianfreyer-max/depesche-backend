// GET /api/articles                 → Briefing (Standardquellen)
// GET /api/articles?feeds=[…]       → Briefing inkl. eigener Quellen
// GET /api/articles?discover=<url>  → RSS-/Atom-Feed einer Website finden

const { cors, queryParams, hasRedis } = require("./_lib");
const { getBriefing, discoverFeed, parseCustomFeeds } = require("./_briefing");

module.exports = async (req, res) => {
  cors(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Nur GET" }); return; }

  const params = queryParams(req);

  const discover = params.get("discover");
  if (discover) {
    res.setHeader("Cache-Control", "no-store");
    try {
      const found = await discoverFeed(discover);
      if (found) res.status(200).json({ ok: true, feedUrl: found.feedUrl, title: found.title });
      else res.status(200).json({ ok: false, error: "Kein RSS-/Atom-Feed auf dieser Seite gefunden." });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  try {
    const extraFeeds = parseCustomFeeds(params.get("feeds"));
    const { data, state } = await getBriefing(extraFeeds, { mode: "swr" });
    // Mit Redis: Das gespeicherte Briefing antwortet ohnehin sofort, der CDN-Cache fängt nur Spitzen ab.
    // Ohne Redis: Der CDN-Cache ist der einzige Zwischenspeicher (veraltet ausliefern, im Hintergrund erneuern).
    res.setHeader(
      "Cache-Control",
      hasRedis() ? "public, s-maxage=60, stale-while-revalidate=600" : "public, s-maxage=1800, stale-while-revalidate=86400"
    );
    res.setHeader("X-Briefing-State", state);
    res.status(200).json({ ...data, state });
  } catch (e) {
    console.error("Briefing fehlgeschlagen:", e);
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: e.message, articles: [] });
  }
};
