import { buildPushHTTPRequest } from "@pushforge/builder";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
};

// Change this if you're not in Eastern time — must be an IANA timezone name.
const TIMEZONE = "America/New_York";

// How often the cron fires and how wide each checking window is, in minutes.
// A compound scheduled for any time inside a given 5-minute window gets
// picked up the next time this runs — so a dose set for 8:03 fires with
// the 8:00-8:05 check, not necessarily at the literal minute 8:03.
const WINDOW_MINUTES = 5;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const protectedPaths = ["/subscribe", "/peptides", "/test"];
    if (protectedPaths.includes(url.pathname)) {
      const key = request.headers.get("X-API-Key");
      if (!env.API_SECRET || key !== env.API_SECRET) {
        return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
      }
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      const sub = await request.json();
      await env.SUBSCRIPTIONS.put("subscription", JSON.stringify(sub));
      return new Response("OK", { headers: CORS_HEADERS });
    }

    if (url.pathname === "/peptides" && request.method === "POST") {
      const peptides = await request.json();
      await env.SUBSCRIPTIONS.put("peptides", JSON.stringify(peptides));
      return new Response("OK", { headers: CORS_HEADERS });
    }

    // Manual test endpoint.
    //   POST /test          -> only sends if something is due in THIS exact
    //                          5-minute window right now (tests the real logic)
    //   POST /test?force=1  -> ignores timing and sends everything due today,
    //                          useful for a quick end-to-end sanity check
    if (url.pathname === "/test" && request.method === "POST") {
      const force = url.searchParams.get("force") === "1";
      const result = await checkAndSendDue(env, force);
      return new Response(result, { headers: CORS_HEADERS });
    }

    return new Response("Peptide push worker is running.", { headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndSendDue(env, false));
  },
};

function todayKey() {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date()); // "YYYY-MM-DD"
}

function currentMinutes() {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = fmt.formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === "hour").value, 10);
  const minute = parseInt(parts.find((p) => p.type === "minute").value, 10);
  return hour * 60 + minute;
}

function timeToMinutes(t) {
  const [h, m] = (t || "08:00").split(":").map(Number);
  return h * 60 + (m || 0);
}

function daysBetween(startKey, targetKey) {
  const start = new Date(startKey + "T00:00:00Z");
  const target = new Date(targetKey + "T00:00:00Z");
  return Math.round((target - start) / 86400000);
}

function isDueToday(p, today) {
  if (p.cycleType === "adhoc") return false;
  if (!p.startDate || today < p.startDate) return false;
  if (p.endDate && today > p.endDate) return false;

  if (p.cycleType === "daily") return true;

  if (p.cycleType === "weekdays") {
    const dow = new Date(today + "T00:00:00Z").getUTCDay();
    return (p.weekdays || []).includes(dow);
  }

  if (p.cycleType === "onoff") {
    const on = Math.max(1, p.onDays || 1);
    const off = Math.max(0, p.offDays || 0);
    const cycleLen = on + off;
    if (cycleLen <= 0) return true;
    const diff = daysBetween(p.startDate, today);
    const pos = ((diff % cycleLen) + cycleLen) % cycleLen;
    return pos < on;
  }

  return false;
}

async function checkAndSendDue(env, force) {
  const subRaw = await env.SUBSCRIPTIONS.get("subscription");
  if (!subRaw) return "no subscription stored yet";

  const peptidesRaw = await env.SUBSCRIPTIONS.get("peptides");
  const peptides = peptidesRaw ? JSON.parse(peptidesRaw) : [];
  const today = todayKey();
  const nowMin = currentMinutes();
  const windowStart = Math.floor(nowMin / WINDOW_MINUTES) * WINDOW_MINUTES;
  const windowEnd = windowStart + WINDOW_MINUTES;

  const due = [];
  for (const p of peptides) {
    if (!isDueToday(p, today)) continue;
    const times = Array.isArray(p.times) && p.times.length ? p.times : [p.time || "08:00"];
    for (const t of times) {
      const mins = timeToMinutes(t);
      if (force || (mins >= windowStart && mins < windowEnd)) {
        due.push({ name: p.name, dose: p.dose, unit: p.unit });
      }
    }
  }

  if (due.length === 0) return force ? "nothing due today" : "nothing due in this window";

  if (!force) {
    const sentKey = `sent:${today}:${windowStart}`;
    const already = await env.SUBSCRIPTIONS.get(sentKey);
    if (already) return "already sent for this window";
    await env.SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 86400 });
  }

  const names = due.map((d) => (d.dose && d.unit ? `${d.name} (${d.dose}${d.unit})` : d.name));
  const body = names.length <= 4 ? names.join(", ") : `${names.slice(0, 4).join(", ")} +${names.length - 4} more`;
  const title = `${due.length} dose${due.length > 1 ? "s" : ""} due now`;

  const subscription = JSON.parse(subRaw);
  const privateJWK = JSON.parse(env.VAPID_PRIVATE_KEY);

  const { endpoint, headers, body: pushBody } = await buildPushHTTPRequest({
    privateJWK,
    subscription,
    message: {
      payload: { title, body },
      adminContact: env.VAPID_SUBJECT,
      options: { ttl: 3600, urgency: "high" },
    },
  });

  const res = await fetch(endpoint, { method: "POST", headers, body: pushBody });

  if (res.status === 404 || res.status === 410) {
    await env.SUBSCRIPTIONS.delete("subscription");
  }

  return res.ok ? "sent" : `push service returned ${res.status}`;
}
