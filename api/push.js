// Mitteilungen verwalten (wird von der App aufgerufen)
//
// GET  /api/push?action=key                     → öffentlicher Schlüssel + Einrichtungsstatus
// POST /api/push {action:"subscribe", subscription, settings, origin}
// POST /api/push {action:"settings",  endpoint, settings}
// POST /api/push {action:"status",    endpoint}
// POST /api/push {action:"test",      endpoint}
// POST /api/push {action:"unsubscribe", endpoint}

const { cors, queryParams, readJsonBody, publicBaseUrl } = require("./_lib");
const P = require("./_push");

function configured() {
  return { redis: P.hasRedis(), scheduler: process.env.QSTASH_TOKEN ? "qstash" : "none" };
}

async function statusFor(rec, req) {
  const cfg = configured();
  let schedule = null;
  if (cfg.redis) {
    schedule = cfg.scheduler === "qstash" ? await P.ensureSchedule(publicBaseUrl(req)) : null;
  }
  const out = {
    ok: true,
    configured: cfg,
    subscribed: !!rec,
    settings: rec ? rec.settings : null,
    lastSentAt: rec ? rec.lastSentAt || null : null,
    lastError: rec ? rec.lastError || null : null,
    schedule: schedule ? { ok: !!schedule.ok, error: schedule.error || null, cron: schedule.cron || null } : null,
    sources: P.defaultSources(),
  };
  // Ohne QStash: Adresse für einen externen Zeitplan-Dienst (z. B. cron-job.org) anzeigen
  if (rec && cfg.scheduler === "none") {
    out.dispatchUrl = `${publicBaseUrl(req)}/api/push-dispatch?key=${await P.getSecret()}`;
  }
  return out;
}

module.exports = async (req, res) => {
  cors(res, "GET, POST, OPTIONS");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const cfg = configured();
  if (!cfg.redis) {
    res.status(200).json({
      ok: false, configured: cfg,
      error: "Speicher fehlt: Upstash Redis ist noch nicht mit dem Backend-Projekt verbunden.",
    });
    return;
  }

  try {
    if (req.method === "GET") {
      const action = queryParams(req).get("action");
      if (action !== "key") { res.status(400).json({ ok: false, error: "Unbekannte Aktion" }); return; }
      const v = await P.getVapid();
      res.status(200).json({ ok: true, publicKey: v.publicKey, configured: cfg, sources: P.defaultSources() });
      return;
    }
    if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Nur GET/POST" }); return; }

    const body = await readJsonBody(req);
    const action = body.action;

    if (action === "subscribe") {
      if (!P.validSubscription(body.subscription)) { res.status(400).json({ ok: false, error: "Ungültiges Abonnement" }); return; }
      const existing = await P.getSub(body.subscription.endpoint);
      if (!existing && (await P.countSubs()) >= P.MAX_SUBS) {
        res.status(429).json({ ok: false, error: "Zu viele Geräte angemeldet" });
        return;
      }
      const settings = P.sanitizeSettings(body.settings);
      const origin = typeof body.origin === "string" && /^https:\/\/[^/]+$/.test(body.origin) ? body.origin : (existing && existing.origin) || "";
      await P.getVapid(origin); // sicherstellen, dass Schlüssel existieren
      const now = new Date().toISOString();
      const rec = {
        subscription: { endpoint: body.subscription.endpoint, keys: body.subscription.keys },
        settings,
        origin,
        createdAt: (existing && existing.createdAt) || now,
        updatedAt: now,
        // Eilmeldungen erst ab jetzt – sonst kämen beim Einschalten alle älteren Treffer auf einmal
        state: { ...((existing && existing.state) || {}), breakingSince: (existing && existing.state && existing.state.breakingSince) || now },
      };
      await P.saveSub(rec);
      res.status(200).json(await statusFor(rec, req));
      return;
    }

    const rec = await P.getSub(body.endpoint);

    if (action === "status") { res.status(200).json(await statusFor(rec, req)); return; }

    if (!rec) { res.status(404).json({ ok: false, subscribed: false, error: "Dieses Gerät ist nicht angemeldet." }); return; }

    if (action === "settings") {
      const before = rec.settings;
      rec.settings = P.sanitizeSettings(body.settings);
      rec.updatedAt = new Date().toISOString();
      rec.state = rec.state || {};
      if (rec.settings.breaking.enabled && !(before && before.breaking && before.breaking.enabled)) {
        rec.state.breakingSince = rec.updatedAt; // frisch eingeschaltet: nichts Altes nachliefern
      }
      await P.saveSub(rec);
      res.status(200).json(await statusFor(rec, req));
      return;
    }

    if (action === "test") {
      const r = await P.sendTest(rec);
      res.status(200).json({ ok: r.ok, status: r.status, error: r.ok ? null : r.error, removed: !!r.gone });
      return;
    }

    if (action === "unsubscribe") {
      await P.deleteSub(rec.subscription.endpoint);
      if ((await P.countSubs()) === 0) await P.deleteSchedule();
      res.status(200).json({ ok: true, subscribed: false });
      return;
    }

    res.status(400).json({ ok: false, error: "Unbekannte Aktion" });
  } catch (e) {
    console.error("push:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
};
