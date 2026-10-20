// Gemeinsame Hilfsfunktionen für alle Endpunkte.
// Dateien mit Unterstrich im api-Ordner werden von Vercel NICHT als eigener Endpunkt veröffentlicht.

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Redis (Upstash, REST) – ohne zusätzliche Abhängigkeit.
// Die Zugangsdaten setzt Vercel automatisch, sobald Upstash Redis mit dem
// Projekt verbunden ist. Je nach Einrichtung heißen die Variablen
// KV_REST_API_URL/…_TOKEN oder UPSTASH_REDIS_REST_URL/…_TOKEN (ggf. mit eigenem Präfix).
// ---------------------------------------------------------------------------
function findEnv(re, exclude) {
  const key = Object.keys(process.env).find((k) => re.test(k) && !(exclude && exclude.test(k)) && process.env[k]);
  return key ? process.env[key] : "";
}

function redisConfig() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    findEnv(/(_REST_API_URL|_REDIS_REST_URL)$/);
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    findEnv(/(_REST_API_TOKEN|_REDIS_REST_TOKEN)$/, /READ_ONLY/);
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

function hasRedis() {
  return !!redisConfig();
}

async function redisFetch(path, body) {
  const cfg = redisConfig();
  if (!cfg) throw new Error("Redis nicht konfiguriert");
  const res = await fetch(cfg.url + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error("Redis HTTP " + res.status + " " + JSON.stringify(data).slice(0, 160));
  return data;
}

// Ein Befehl, z. B. redis(["GET", "key"])
async function redis(cmd) {
  const data = await redisFetch("", cmd);
  if (data && data.error) throw new Error("Redis: " + data.error);
  return data ? data.result : null;
}

// Mehrere Befehle in einer Anfrage
async function redisPipeline(cmds) {
  if (!cmds.length) return [];
  const data = await redisFetch("/pipeline", cmds);
  return (data || []).map((r) => (r && !r.error ? r.result : null));
}

async function redisGetJson(key) {
  const raw = await redis(["GET", key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function redisSetJson(key, value, ttlSeconds) {
  const cmd = ["SET", key, JSON.stringify(value)];
  if (ttlSeconds) cmd.push("EX", String(ttlSeconds));
  return redis(cmd);
}

// ---------------------------------------------------------------------------
// Allgemeines
// ---------------------------------------------------------------------------
function sha(text, len = 24) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, len);
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", middot: "·",
  bull: "•", euro: "€", copy: "©", reg: "®", trade: "™", deg: "°", times: "×",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  eacute: "é", egrave: "è", agrave: "à", aacute: "á", ccedil: "ç", ntilde: "ñ",
  oacute: "ó", iacute: "í", uacute: "ú", ecirc: "ê", ocirc: "ô",
};

// Wandelt HTML-Entities (&#8217; &hellip; &amp; …) in echte Zeichen um.
function decodeEntities(str) {
  if (!str) return "";
  return String(str).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return Number.isFinite(n) ? String.fromCodePoint(n) : m; } catch (e) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, code) ? NAMED_ENTITIES[code] : m;
  });
}

function cors(res, methods = "GET, OPTIONS") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function queryParams(req) {
  try { return new URL(req.url, "http://localhost").searchParams; } catch (e) { return new URLSearchParams(); }
}

// Liest einen JSON-Body – egal ob die Plattform ihn schon geparst hat oder nicht.
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString("utf8")); } catch (e) { return {}; } }
  const chunks = [];
  try {
    for await (const c of req) chunks.push(c);
  } catch (e) { return {}; }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { return {}; }
}

// Öffentliche Adresse dieses Backends (für den Zeitplan-Aufruf)
function publicBaseUrl(req) {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const host = (req && (req.headers["x-forwarded-host"] || req.headers.host)) || "";
  return host ? "https://" + host : "";
}

// Hintergrundarbeit nach der Antwort weiterlaufen lassen (Vercel „waitUntil").
// Gibt false zurück, wenn die Plattform das nicht anbietet (z. B. lokal).
function runInBackground(promise) {
  const ctx = globalThis[Symbol.for("@vercel/request-context")];
  const wu = ctx && ctx.get && ctx.get() && ctx.get().waitUntil;
  if (typeof wu === "function") {
    wu(promise.catch((e) => console.error("Hintergrundaufgabe fehlgeschlagen:", e.message)));
    return true;
  }
  promise.catch((e) => console.error("Hintergrundaufgabe fehlgeschlagen:", e.message));
  return false;
}

module.exports = {
  hasRedis, redis, redisPipeline, redisGetJson, redisSetJson,
  sha, decodeEntities, cors, queryParams, readJsonBody, publicBaseUrl, runInBackground,
};
