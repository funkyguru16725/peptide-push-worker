import { buildPushHTTPRequest } from "@pushforge/builder";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
};

// Change this if you're not in Eastern time — must be an IANA timezone name.
const TIMEZONE = "America/New_York";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // every endpoint below requires the shared secret, so only your own app
    // (which knows this key) can read or write anything on this Worker
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

    // Manual test endpoint — POST here any time to fire a push immediately,
    // using whatever's actually due today, same as the real schedule would.
    if (url.pathname === "/test" && request.method === "POST") {
      const result = await sendReminder(env);
      return new Response(result, { headers: CORS_HEADERS });
    }

    return new Response("Peptide push worker is running.", { headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminder(env));
  },
};

function todayKey() {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date()); // "YYYY-MM-DD"
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

async function sendReminder(env) {
  const subRaw = await env.SUBSCRIPTIONS.get("subscription");
  if (!subRaw) return "no subscription stored yet";

  const peptidesRaw = await env.SUBSCRIPTIONS.get("peptides");
  const peptides = peptidesRaw ? JSON.parse(peptidesRaw) : [];
  const today = todayKey();
  const due = peptides.filter((p) => isDueToday(p, today));

  if (due.length === 0) {
    return "nothing due today, no push sent";
  }

  const names = due.map((p) => (p.dose && p.unit ? `${p.name} (${p.dose}${p.unit})` : p.name));
  const body = names.length <= 4 ? names.join(", ") : `${names.slice(0, 4).join(", ")} +${names.length - 4} more`;

  const subscription = JSON.parse(subRaw);
  const privateJWK = JSON.parse(env.VAPID_PRIVATE_KEY);

  const { endpoint, headers, body: pushBody } = await buildPushHTTPRequest({
    privateJWK,
    subscription,
    message: {
      payload: {
        title: `${due.length} dose${due.length > 1 ? "s" : ""} due today`,
        body,
      },
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
