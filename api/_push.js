// Push-Mitteilungen: Schlüssel, Abonnements, Einstellungen, Zeitplan und Versand.

const crypto = require("crypto");
const webpush = require("web-push");
const { hasRedis, redis, redisPipeline, redisGetJson, redisSetJson, sha } = require("./_lib");
const { getBriefing, parseCustomFeeds, FEEDS } = require("./_briefing");

const MAX_SUBS = 20;
const SCHEDULE_ID = "datenradar-push";
const SCHEDULE_CRON = "*/10 * * * *"; // alle 10 Minuten nachsehen, ob etwas fällig ist
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://depesche-frontend.vercel.app").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Schlüssel (VAPID) und Geheimnis – werden beim ersten Gebrauch erzeugt und in Redis abgelegt,
// es müssen also keine Schlüssel von Hand eingetragen werden.
// ---------------------------------------------------------------------------
async function getVapid(origin) {
  let v = await redisGetJson("dr:vapid");
  if (v && v.publicKey && v.privateKey) return v;
  const keys = webpush.generateVAPIDKeys();
  const subject =
    process.env.PUSH_SUBJECT ||
    (origin && /^https:\/\//.test(origin) ? origin : "") ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : "https://depesche-frontend.vercel.app");
  await redis(["SET", "dr:vapid", JSON.stringify({ ...keys, subject, createdAt: new Date().toISOString() }), "NX"]);
  v = await redisGetJson("dr:vapid");
  return v;
}

async function getSecret() {
  let s = await redis(["GET", "dr:secret"]);
  if (s) return s;
  await redis(["SET", "dr:secret", crypto.randomBytes(24).toString("hex"), "NX"]);
  return redis(["GET", "dr:secret"]);
}

// ---------------------------------------------------------------------------
// Einstellungen prüfen und vereinheitlichen
// ---------------------------------------------------------------------------
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function toMin(t) { const m = HHMM.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; }
function validTz(tz) {
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch (e) { return false; }
}
function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
function cleanList(arr, max, maxLen) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (typeof x !== "string") continue;
    const s = x.trim().slice(0, maxLen);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeSettings(input) {
  const s = input && typeof input === "object" ? input : {};
  const b = s.briefing || {};
  const k = s.breaking || {};
  const times = [...new Set((Array.isArray(b.times) ? b.times : []).filter((t) => HHMM.test(t)))].sort().slice(0, 4);
  const days = [...new Set((Array.isArray(b.days) ? b.days : []).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
  return {
    tz: typeof s.tz === "string" && validTz(s.tz) ? s.tz : "Europe/Berlin",
    briefing: {
      enabled: !!b.enabled,
      times: times.length ? times : ["07:30"],
      days: days.length ? days : [1, 2, 3, 4, 5, 6, 7],
      count: clampInt(b.count, 1, 5, 3),
    },
    breaking: {
      enabled: !!k.enabled,
      keywords: cleanList(k.keywords, 15, 40),
      sources: cleanList(k.sources, 30, 40),
      quietFrom: HHMM.test(k.quietFrom || "") ? k.quietFrom : "",
      quietTo: HHMM.test(k.quietTo || "") ? k.quietTo : "",
      maxPerDay: clampInt(k.maxPerDay, 1, 20, 6),
    },
    feeds: parseCustomFeeds(s.feeds),
  };
}

// ---------------------------------------------------------------------------
// Abonnements
// ---------------------------------------------------------------------------
function subId(endpoint) { return sha(endpoint, 24); }

function validSubscription(sub) {
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys) return false;
  if (typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") return false;
  try {
    const u = new URL(sub.endpoint);
    return u.protocol === "https:" && sub.endpoint.length < 1000;
  } catch (e) { return false; }
}

async function getSub(endpoint) {
  if (!endpoint) return null;
  return redisGetJson("dr:sub:" + subId(endpoint));
}

async function saveSub(rec) {
  await redisSetJson("dr:sub:" + subId(rec.subscription.endpoint), rec);
  await redis(["SADD", "dr:subs", subId(rec.subscription.endpoint)]);
}

async function deleteSub(endpoint) {
  const id = subId(endpoint);
  await redisPipeline([["DEL", "dr:sub:" + id], ["SREM", "dr:subs", id]]);
}

async function listSubs() {
  const ids = (await redis(["SMEMBERS", "dr:subs"])) || [];
  if (!ids.length) return [];
  const raws = await redisPipeline(ids.map((id) => ["GET", "dr:sub:" + id]));
  const out = [];
  raws.forEach((raw, i) => {
    if (!raw) { redis(["SREM", "dr:subs", ids[i]]).catch(() => {}); return; }
    try { out.push(JSON.parse(raw)); } catch (e) { /* ignorieren */ }
  });
  return out;
}

async function countSubs() {
  return (await redis(["SCARD", "dr:subs"])) || 0;
}

// ---------------------------------------------------------------------------
// Zeitplan (Upstash QStash) – wird automatisch angelegt, sobald QStash verbunden ist
// ---------------------------------------------------------------------------
function qstashBase() {
  return (process.env.QSTASH_URL || "https://qstash.upstash.io").replace(/\/+$/, "");
}

async function ensureSchedule(baseUrl, { force = false } = {}) {
  if (!process.env.QSTASH_TOKEN) return { ok: false, reason: "no-qstash" };
  if (!baseUrl) return { ok: false, reason: "no-url" };
  const dest = baseUrl + "/api/push-dispatch";
  const known = await redisGetJson("dr:schedule");
  if (!force && known && known.ok && known.dest === dest && Date.now() - Date.parse(known.at) < 7 * 864e5) return known;
  const secret = await getSecret();
  let result;
  try {
    const res = await fetch(`${qstashBase()}/v2/schedules/${dest}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.QSTASH_TOKEN,
        "Content-Type": "application/json",
        "Upstash-Cron": SCHEDULE_CRON,
        "Upstash-Schedule-Id": SCHEDULE_ID,
        "Upstash-Method": "POST",
        "Upstash-Retries": "0",
      },
      body: JSON.stringify({ key: secret }),
    });
    const text = await res.text();
    result = res.ok
      ? { ok: true, dest, at: new Date().toISOString(), cron: SCHEDULE_CRON }
      : { ok: false, dest, at: new Date().toISOString(), error: `QStash ${res.status}: ${text.slice(0, 200)}` };
  } catch (e) {
    result = { ok: false, dest, at: new Date().toISOString(), error: e.message };
  }
  await redisSetJson("dr:schedule", result);
  return result;
}

async function deleteSchedule() {
  if (!process.env.QSTASH_TOKEN) return;
  try {
    await fetch(`${qstashBase()}/v2/schedules/${SCHEDULE_ID}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + process.env.QSTASH_TOKEN },
    });
  } catch (e) { /* nicht kritisch */ }
  await redis(["DEL", "dr:schedule"]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Versand
// ---------------------------------------------------------------------------
// Format „Declarative Web Push" (Safari/iOS ab 18.4 zeigt es direkt an, ältere Geräte und
// andere Browser verarbeiten dieselben Daten im Service Worker der App).
function buildPayload({ title, body, navigate, tag, badge }) {
  const p = {
    web_push: 8030,
    notification: { title, body, navigate, lang: "de-DE", dir: "ltr", silent: false },
  };
  if (tag) p.notification.tag = tag;
  if (Number.isFinite(badge)) p.app_badge = Math.max(0, Math.min(99, badge));
  return p;
}

async function sendPush(rec, payload, vapid) {
  try {
    const r = await webpush.sendNotification(rec.subscription, JSON.stringify(payload), {
      TTL: 6 * 3600,
      urgency: "high",
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      timeout: 15000,
    });
    return { ok: true, status: r.statusCode };
  } catch (e) {
    const status = e.statusCode || 0;
    const gone = status === 404 || status === 410;
    return { ok: false, status, gone, error: (e.body || e.message || "").toString().slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Zeit-Hilfen
// ---------------------------------------------------------------------------
const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const WD_DE = ["", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
function localParts(tz, date) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, minutes: (+p.hour % 24) * 60 + +p.minute, weekday: WD[p.weekday] || 1 };
}
function inQuietHours(minutes, from, to) {
  const f = toMin(from), t = toMin(to);
  if (f == null || t == null || f === t) return false;
  return f < t ? minutes >= f && minutes < t : minutes >= f || minutes < t;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function keywordMatcher(keywords) {
  const res = keywords.map((kw) => ({ kw, re: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(kw)}(?=$|[^\\p{L}\\p{N}])`, "iu") }));
  return (a) => {
    const text = [a.headline, a.summary, a.origHeadline, a.origSummary].join(" \n ");
    return res.filter((r) => r.re.test(text)).map((r) => r.kw);
  };
}
function bullet(text, max = 110) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return "• " + (t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t);
}

// ---------------------------------------------------------------------------
// Inhalte
// ---------------------------------------------------------------------------
function briefingMessage(rec, articles, { slotLabel, lp, now }) {
  const s = rec.settings;
  const top = articles.slice(0, s.briefing.count);
  const since = rec.state && rec.state.lastBriefingAt ? Date.parse(rec.state.lastBriefingAt) : now - 24 * 3600e3;
  const newCount = articles.filter((a) => a.published && Date.parse(a.published) > since).length;
  const lines = top.map((a) => bullet(a.headline));
  const rest = newCount - top.length;
  if (rest > 0) lines.push(`+ ${rest} weitere neue Meldung${rest === 1 ? "" : "en"}`);
  const origin = rec.origin || FRONTEND_URL;
  return buildPayload({
    title: `Briefing · ${WD_DE[lp.weekday]}${slotLabel ? " " + slotLabel : ""}`,
    body: lines.join("\n") || "Keine neuen Meldungen.",
    navigate: origin + "/?src=briefing",
    tag: "briefing",
    badge: newCount,
  });
}

function breakingMessage(rec, hits) {
  const origin = rec.origin || FRONTEND_URL;
  const kws = [...new Set(hits.flatMap((h) => h.kws))];
  if (hits.length === 1) {
    const a = hits[0].a;
    return buildPayload({
      title: `Eilmeldung · ${kws.join(", ")}`,
      body: `${a.headline}\n${a.source}`,
      navigate: `${origin}/?a=${encodeURIComponent(a.id)}`,
      tag: "breaking-" + a.id,
    });
  }
  return buildPayload({
    title: `${hits.length} neue Meldungen · ${kws.slice(0, 3).join(", ")}`,
    body: hits.slice(0, 4).map((h) => bullet(h.a.headline, 90)).join("\n"),
    navigate: `${origin}/?src=breaking`,
    tag: "breaking",
  });
}

// ---------------------------------------------------------------------------
// Zeitplan-Lauf: für jedes Abo prüfen, ob ein Briefing oder eine Eilmeldung fällig ist
// ---------------------------------------------------------------------------
async function dispatchAll({ now = Date.now(), only = null } = {}) {
  const lock = await redis(["SET", "dr:dispatch:lock", "1", "NX", "EX", "250"]);
  if (lock !== "OK") return { skipped: "läuft bereits" };
  try {
    const subs = (await listSubs()).filter((r) => !only || subId(r.subscription.endpoint) === only);
    if (!subs.length) return { subs: 0 };
    const vapid = await getVapid();
    const briefings = new Map(); // je Quellen-Kombination nur einmal laden
    const report = [];

    for (const rec of subs) {
      const s = rec.settings;
      rec.state = rec.state || {};
      const st = rec.state;
      st.briefSent = st.briefSent || {};
      st.sentIds = st.sentIds || [];
      st.daily = st.daily || {};
      const lp = localParts(s.tz, new Date(now));
      const lpY = localParts(s.tz, new Date(now - 864e5));
      const entry = { id: subId(rec.subscription.endpoint), sent: [] };

      // Fällige Briefing-Termine (bis 3 h nachholen, falls ein Lauf ausfällt)
      const due = [];
      if (s.briefing.enabled) {
        for (const [day, offset] of [[lp, 0], [lpY, 1440]]) {
          if (!s.briefing.days.includes(day.weekday)) continue;
          for (const t of s.briefing.times) {
            const diff = lp.minutes + offset - toMin(t);
            const key = `${day.ymd} ${t}`;
            if (diff >= 0 && diff <= 180 && !st.briefSent[key]) due.push({ key, t });
          }
        }
      }
      const wantBreaking =
        s.breaking.enabled && s.breaking.keywords.length && !inQuietHours(lp.minutes, s.breaking.quietFrom, s.breaking.quietTo);
      if (!due.length && !wantBreaking) { report.push(entry); continue; }

      const fk = JSON.stringify(s.feeds || []);
      if (!briefings.has(fk)) {
        briefings.set(fk, getBriefing(s.feeds || [], { mode: "sync" }).then((r) => r.data.articles || []).catch(() => []));
      }
      const articles = await briefings.get(fk);
      if (!articles.length) { entry.error = "keine Artikel"; report.push(entry); continue; }

      let result = null;
      const sentIds = new Set(st.sentIds);

      if (due.length) {
        const slot = due[due.length - 1];
        result = await sendPush(rec, briefingMessage(rec, articles, { slotLabel: slot.t, lp, now }), vapid);
        entry.sent.push({ type: "briefing", slot: slot.key, ...result });
        if (result.ok || !result.gone) {
          due.forEach((d) => { st.briefSent[d.key] = new Date(now).toISOString(); });
          st.lastBriefingAt = new Date(now).toISOString();
          // Was im Briefing stand, nicht noch einmal als Eilmeldung schicken
          articles.slice(0, s.briefing.count).forEach((a) => sentIds.add(a.id));
        }
      }

      if (wantBreaking && !(result && result.gone)) {
        const match = keywordMatcher(s.breaking.keywords);
        // 2 min Toleranz, weil Feeds Zeiten oft nur sekundengenau angeben
        const since = Math.max((Date.parse(st.breakingSince || 0) || 0) - 120e3, now - 36 * 3600e3);
        const srcOk = (a) => !s.breaking.sources.length || s.breaking.sources.includes(a.source);
        const hits = [];
        for (const a of articles) {
          if (!a.published || Date.parse(a.published) < since || sentIds.has(a.id) || !srcOk(a)) continue;
          const kws = match(a);
          if (kws.length) hits.push({ a, kws });
        }
        if (hits.length) {
          const used = st.daily[lp.ymd] || 0;
          if (used < s.breaking.maxPerDay) {
            const r = await sendPush(rec, breakingMessage(rec, hits), vapid);
            entry.sent.push({ type: "breaking", count: hits.length, ...r });
            if (r.gone) result = r;
            else if (r.ok) st.daily[lp.ymd] = used + 1;
          }
          hits.forEach((h) => sentIds.add(h.a.id));
        }
      }

      if (result && result.gone) {
        await deleteSub(rec.subscription.endpoint);
        entry.removed = true;
        report.push(entry);
        continue;
      }

      // Zustand aufräumen und speichern
      st.sentIds = [...sentIds].slice(-400);
      st.briefSent = Object.fromEntries(Object.entries(st.briefSent).sort().slice(-30));
      st.daily = Object.fromEntries(Object.entries(st.daily).sort().slice(-7));
      const last = entry.sent[entry.sent.length - 1];
      if (last) { rec.lastSentAt = new Date(now).toISOString(); rec.lastError = last.ok ? null : `${last.status} ${last.error || ""}`.trim(); }
      await saveSub(rec);
      report.push(entry);
    }
    return { subs: subs.length, report };
  } finally {
    await redis(["DEL", "dr:dispatch:lock"]).catch(() => {});
  }
}

// Sofort eine Probe des Briefings an ein Gerät schicken
async function sendTest(rec) {
  const vapid = await getVapid();
  const { data } = await getBriefing(rec.settings.feeds || [], { mode: "swr" });
  const articles = (data && data.articles) || [];
  const lp = localParts(rec.settings.tz, new Date());
  const payload = articles.length
    ? briefingMessage({ ...rec, state: {} }, articles, { slotLabel: "(Test)", lp, now: Date.now() })
    : buildPayload({ title: "Datenradar · Test", body: "Mitteilungen funktionieren.", navigate: (rec.origin || FRONTEND_URL) + "/" });
  const r = await sendPush(rec, payload, vapid);
  if (r.gone) await deleteSub(rec.subscription.endpoint);
  return r;
}

function defaultSources() {
  return FEEDS.map((f) => f.source);
}

module.exports = {
  hasRedis, getVapid, getSecret, sanitizeSettings, validSubscription, getSub, saveSub, deleteSub,
  countSubs, ensureSchedule, deleteSchedule, dispatchAll, sendTest, defaultSources, subId,
  MAX_SUBS,
  _internals: { localParts, inQuietHours, keywordMatcher, briefingMessage, breakingMessage, toMin },
};
