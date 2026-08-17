import { buildPushHTTPRequest } from "@pushforge/builder";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      const sub = await request.json();
      await env.SUBSCRIPTIONS.put("subscription", JSON.stringify(sub));
      return new Response("OK", { headers: CORS_HEADERS });
    }

    // Manual test endpoint — POST here any time to fire a push immediately,
    // handy for confirming everything works before trusting the schedule.
    if (url.pathname === "/test" && request.method === "POST") {
      const sent = await sendReminder(env);
      return new Response(sent ? "sent" : "no subscription stored yet", { headers: CORS_HEADERS });
    }

    return new Response("Peptide push worker is running.", { headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminder(env));
  },
};

async function sendReminder(env) {
  const raw = await env.SUBSCRIPTIONS.get("subscription");
  if (!raw) return false;

  const subscription = JSON.parse(raw);
  const privateJWK = JSON.parse(env.VAPID_PRIVATE_KEY);

  const { endpoint, headers, body } = await buildPushHTTPRequest({
    privateJWK,
    subscription,
    message: {
      payload: {
        title: "Peptide Tracker",
        body: "Time to log today's doses.",
      },
      adminContact: env.VAPID_SUBJECT,
      options: { ttl: 3600, urgency: "high" },
    },
  });

  const res = await fetch(endpoint, { method: "POST", headers, body });

  // the push service tells us if a subscription is dead (e.g. you revoked
  // permission) — clean it up so we're not repeatedly failing silently
  if (res.status === 404 || res.status === 410) {
    await env.SUBSCRIPTIONS.delete("subscription");
  }

  return res.ok;
}
