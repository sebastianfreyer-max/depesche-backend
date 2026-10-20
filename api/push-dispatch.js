// Zeitplan-Endpunkt: wird alle 10 Minuten von Upstash QStash aufgerufen (oder von einem
// anderen Zeitplan-Dienst mit ?key=…). Schickt fällige Briefings und Eilmeldungen.

const { queryParams, readJsonBody, hasRedis } = require("./_lib");
const P = require("./_push");

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (!hasRedis()) { res.status(200).json({ ok: false, error: "Redis nicht konfiguriert" }); return; }

  // Zugang: Geheimnis aus dem Body (QStash), aus ?key= (externer Dienst) oder Vercel-Cron (CRON_SECRET)
  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const given = (body && body.key) || queryParams(req).get("key") || "";
  const auth = req.headers.authorization || "";
  const secret = await P.getSecret();
  const ok = (given && given === secret) || (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`);
  if (!ok) { res.status(401).json({ ok: false, error: "Nicht berechtigt" }); return; }

  try {
    const result = await P.dispatchAll();
    // Immer 200, damit der Zeitplan-Dienst keine Wiederholungen auslöst
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error("dispatch:", e);
    res.status(200).json({ ok: false, error: e.message });
  }
};
