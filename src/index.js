import { buildPushHTTPRequest } from "@pushforge/builder";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
};

// Change this if you're not in Eastern time — must be an IANA timezone name.
const TIMEZONE = "America/New_York";

// How often the cron fires and how wide each checking window is, in minutes.
const WINDOW_MINUTES = 5;

// Fixed daily check-in time for the Zone 2 cardio weekly progress summary.
const CARDIO_SUMMARY_TIME = "10:00";
const WEEKLY_ZONE2_GOAL = 150;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const protectedPaths = ["/subscribe", "/peptides", "/cardio", "/training", "/test", "/debug"];
    if (protectedPaths.includes(url.pathname)) {
      const key = request.headers.get("X-API-Key") || url.searchParams.get("key");
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

    if (url.pathname === "/cardio" && request.method === "POST") {
      const cardio = await request.json(); // { weekStart, minutes }
      await env.SUBSCRIPTIONS.put("cardioWeek", JSON.stringify(cardio));
      return new Response("OK", { headers: CORS_HEADERS });
    }

    if (url.pathname === "/training" && request.method === "POST") {
      const training = await request.json(); // { date, type }
      await env.SUBSCRIPTIONS.put("todayTraining", JSON.stringify(training));
      return new Response("OK", { headers: CORS_HEADERS });
    }

    // Manual test endpoint.
    //   POST /test                    -> only sends if a dose is due in THIS
    //                                     exact 5-minute window right now
    //   POST /test?force=1            -> ignores timing, sends everything due today
    //   POST /test?type=cardio        -> only sends if it's cardio check-in time now
    //   POST /test?type=cardio&force=1 -> sends the cardio summary immediately
    if (url.pathname === "/test" && request.method === "POST") {
      const force = url.searchParams.get("force") === "1";
      const type = url.searchParams.get("type");
      const result = type === "cardio" ? await checkCardioSummary(env, force) : await checkAndSendDue(env, force);
      return new Response(result, { headers: CORS_HEADERS });
    }

    // Visit this in a browser (with ?key=YOUR_API_SECRET appended) to see
    // exactly what data the Worker currently has on file.
    if (url.pathname === "/debug") {
      const peptidesRaw = await env.SUBSCRIPTIONS.get("peptides");
      const subRaw = await env.SUBSCRIPTIONS.get("subscription");
      const cardioRaw = await env.SUBSCRIPTIONS.get("cardioWeek");
      const trainingRaw = await env.SUBSCRIPTIONS.get("todayTraining");
      const peptides = peptidesRaw ? JSON.parse(peptidesRaw) : [];
      const today = todayKey();
      const nowMin = currentMinutes();
      const trainingData = trainingRaw ? JSON.parse(trainingRaw) : null;
      const trainingType = trainingData && trainingData.date === today ? trainingData.type : null;
      const summary = {
        hasPushSubscription: !!subRaw,
        workerThinksTodayIs: today,
        workerThinksCurrentTimeIs: `${String(Math.floor(nowMin / 60)).padStart(2, "0")}:${String(nowMin % 60).padStart(2, "0")}`,
        todaysTrainingType: trainingType,
        compoundCount: peptides.length,
        compounds: peptides.map((p) => ({
          name: p.name,
          cycleType: p.cycleType,
          times: p.times || (p.time ? [p.time] : []),
          trainingDays: p.trainingDays || null,
          dueToday: isDueToday(p, today) && passesTrainingFilter(p, trainingType),
        })),
        cardioThisWeek: cardioRaw ? JSON.parse(cardioRaw) : null,
      };
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return new Response("Peptide push worker is running.", { headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndSendDue(env, false));
    ctx.waitUntil(checkCardioSummary(env, false));
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

function inCurrentWindow(scheduledTime, nowMin) {
  const windowStart = Math.floor(nowMin / WINDOW_MINUTES) * WINDOW_MINUTES;
  const windowEnd = windowStart + WINDOW_MINUTES;
  const mins = timeToMinutes(scheduledTime);
  return { matches: mins >= windowStart && mins < windowEnd, windowStart };
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

// Mirrors the app's logic exactly: no restriction = always passes; a
// restriction with no training type picked yet for today also passes
// (show by default), otherwise the picked type must be in the allowed list.
function passesTrainingFilter(p, trainingType) {
  if (!Array.isArray(p.trainingDays) || p.trainingDays.length === 0) return true;
  if (!trainingType) return true;
  return p.trainingDays.includes(trainingType);
}

async function sendPush(env, title, body) {
  const subRaw = await env.SUBSCRIPTIONS.get("subscription");
  if (!subRaw) return "no subscription stored yet";

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

async function checkAndSendDue(env, force) {
  const peptidesRaw = await env.SUBSCRIPTIONS.get("peptides");
  const peptides = peptidesRaw ? JSON.parse(peptidesRaw) : [];
  const today = todayKey();
  const nowMin = currentMinutes();
  const windowStart = Math.floor(nowMin / WINDOW_MINUTES) * WINDOW_MINUTES;
  const windowEnd = windowStart + WINDOW_MINUTES;

  const trainingRaw = await env.SUBSCRIPTIONS.get("todayTraining");
  const trainingData = trainingRaw ? JSON.parse(trainingRaw) : null;
  const trainingType = trainingData && trainingData.date === today ? trainingData.type : null;

  const due = [];
  for (const p of peptides) {
    if (!isDueToday(p, today)) continue;
    if (!passesTrainingFilter(p, trainingType)) continue;
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
  const body = names.join("\n");
  const title = `${due.length} dose${due.length > 1 ? "s" : ""} due now`;

  return sendPush(env, title, body);
}

async function checkCardioSummary(env, force) {
  const nowMin = currentMinutes();
  const { matches } = inCurrentWindow(CARDIO_SUMMARY_TIME, nowMin);
  if (!force && !matches) return "not cardio check-in time yet";

  const today = todayKey();
  if (!force) {
    const sentKey = `cardioSent:${today}`;
    const already = await env.SUBSCRIPTIONS.get(sentKey);
    if (already) return "cardio summary already sent today";
    await env.SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 86400 });
  }

  const cardioRaw = await env.SUBSCRIPTIONS.get("cardioWeek");
  const cardio = cardioRaw ? JSON.parse(cardioRaw) : { minutes: 0 };
  const minutes = cardio.minutes || 0;
  const pct = Math.min(100, Math.round((minutes / WEEKLY_ZONE2_GOAL) * 100));

  const title = "Zone 2 cardio check-in";
  const body = `You're at ${pct}% of your weekly Zone 2 goal (${minutes}/${WEEKLY_ZONE2_GOAL} min).`;

  return sendPush(env, title, body);
}
