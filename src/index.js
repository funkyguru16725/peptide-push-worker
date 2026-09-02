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

// Weekly reminder to import manually-uploaded data (MyFitnessPal, Renpho,
// Fitbit/Google Health) — fires once, on Sundays, at this time.
const IMPORT_REMINDER_TIME = "09:00";
const IMPORT_REMINDER_DAY = 0; // 0 = Sunday

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const protectedPaths = ["/subscribe", "/peptides", "/supplements", "/status", "/cardio", "/training", "/test", "/debug", "/ai-insight"];
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

    if (url.pathname === "/supplements" && request.method === "POST") {
      const supplements = await request.json();
      await env.SUBSCRIPTIONS.put("supplements", JSON.stringify(supplements));
      return new Response("OK", { headers: CORS_HEADERS });
    }

    if (url.pathname === "/status" && request.method === "POST") {
      const status = await request.json();
      await env.SUBSCRIPTIONS.put("status", JSON.stringify(status));
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
    //   POST /test?type=cardio&force=1        -> cardio check-in
    //   POST /test?type=import&force=1        -> weekly import reminder
    //   POST /test?type=lowsupply&force=1     -> low supply alert
    //   POST /test?type=goal&force=1          -> goal milestone
    //   POST /test?type=weeklysummary&force=1 -> weekly summary push
    //   POST /test?type=bloodtest&force=1     -> blood test overdue reminder
    //   POST /test?type=markers&force=1       -> flagged blood markers
    //   POST /test?type=progress&force=1      -> progress photo/waist reminder
    //   POST /test?type=adherence&force=1     -> adherence drop alert
    if (url.pathname === "/test" && request.method === "POST") {
      const force = url.searchParams.get("force") === "1";
      const type = url.searchParams.get("type");
      const checks = {
        cardio: checkCardioSummary,
        import: checkWeeklyImportReminder,
        lowsupply: checkLowSupply,
        goal: checkGoalMilestone,
        weeklysummary: checkWeeklySummaryPush,
        bloodtest: checkBloodTestReminder,
        markers: checkFlaggedMarkers,
        progress: checkProgressReminder,
        adherence: checkAdherenceDrop,
      };
      const result = checks[type] ? await checks[type](env, force) : await checkAndSendDue(env, force);
      return new Response(result, { headers: CORS_HEADERS });
    }

    // POST /ai-insight — generates a written health insight from a data
    // summary and optional attached photos, using your own Anthropic API key
    // (stored as the ANTHROPIC_API_KEY secret, never exposed to the app).
    if (url.pathname === "/ai-insight" && request.method === "POST") {
      if (!env.ANTHROPIC_API_KEY) {
        return new Response(JSON.stringify({ error: "No Anthropic API key configured on this Worker yet." }), {
          status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      try {
        const { dataSummary, note, images, history } = await request.json();
        const isFollowUp = Array.isArray(history) && history.length > 0;

        const newContent = [];
        newContent.push({
          type: "text",
          text: isFollowUp
            ? (note || "Please continue.")
            : "You're looking at someone's own personal health-tracking data (peptides/supplements, macros, weight, training, body composition). " +
              "Give a direct, specific, genuinely useful written analysis — not generic advice. Reference actual numbers from the data. " +
              "If a photo is attached, incorporate visual observations about physique and body composition alongside the numeric data. " +
              "Keep it grounded in lifestyle factors (diet, training, cardio, sleep, recovery) — do not recommend or suggest starting, stopping, " +
              "or adjusting any specific compound, supplement, or medication; that's outside what's appropriate here. " +
              "This is not medical advice, and you should note that if relevant, but don't be excessively hedgy — be concrete and helpful.\n\n" +
              "DATA:\n" + dataSummary +
              (note ? `\n\nSPECIFIC FOCUS REQUESTED: ${note}` : ""),
        });
        (images || []).slice(0, 3).forEach((dataUrl) => {
          const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
          if (match) newContent.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
        });

        const messages = [...(isFollowUp ? history : []), { role: "user", content: newContent }];

        const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-5",
            max_tokens: 8192,
            thinking: { type: "disabled" },
            messages,
          }),
        });

        if (!aiRes.ok) {
          const errText = await aiRes.text();
          return new Response(JSON.stringify({ error: `Anthropic API returned ${aiRes.status}: ${errText.slice(0, 300)}` }), {
            status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }

        const aiData = await aiRes.json();
        const text = (aiData.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
        if (!text) {
          return new Response(JSON.stringify({
            error: `Got an empty response from Anthropic. stop_reason: ${aiData.stop_reason || "unknown"}. Raw response: ${JSON.stringify(aiData).slice(0, 600)}`,
          }), { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ text }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: `Request failed: ${e.message}` }), {
          status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    // Visit this in a browser (with ?key=YOUR_API_SECRET appended) to see
    // exactly what data the Worker currently has on file.
    if (url.pathname === "/debug") {
      const peptidesRaw = await env.SUBSCRIPTIONS.get("peptides");
      const supplementsRaw = await env.SUBSCRIPTIONS.get("supplements");
      const subRaw = await env.SUBSCRIPTIONS.get("subscription");
      const cardioRaw = await env.SUBSCRIPTIONS.get("cardioWeek");
      const trainingRaw = await env.SUBSCRIPTIONS.get("todayTraining");
      const peptides = peptidesRaw ? JSON.parse(peptidesRaw) : [];
      const supplements = supplementsRaw ? JSON.parse(supplementsRaw) : [];
      const today = todayKey();
      const nowMin = currentMinutes();
      const trainingData = trainingRaw ? JSON.parse(trainingRaw) : null;
      const trainingType = trainingData && trainingData.date === today ? trainingData.type : null;
      const describeCompound = (p) => ({
        name: p.name,
        cycleType: p.cycleType,
        times: p.times || (p.time ? [p.time] : []),
        trainingDays: p.trainingDays || null,
        dueToday: isDueToday(p, today) && passesTrainingFilter(p, trainingType),
      });
      const statusRaw = await env.SUBSCRIPTIONS.get("status");
      const status = statusRaw ? JSON.parse(statusRaw) : null;
      const summary = {
        hasPushSubscription: !!subRaw,
        hasAnthropicKey: !!env.ANTHROPIC_API_KEY,
        workerThinksTodayIs: today,
        workerThinksCurrentTimeIs: `${String(Math.floor(nowMin / 60)).padStart(2, "0")}:${String(nowMin % 60).padStart(2, "0")}`,
        workerThinksDayOfWeekIs: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][currentDayOfWeek()],
        isImportReminderDay: currentDayOfWeek() === IMPORT_REMINDER_DAY,
        todaysTrainingType: trainingType,
        compoundCount: peptides.length,
        compounds: peptides.map(describeCompound),
        supplementCount: supplements.length,
        supplements: supplements.map(describeCompound),
        cardioThisWeek: cardioRaw ? JSON.parse(cardioRaw) : null,
        status,
        statusComputed: status ? {
          daysSinceLastPhoto: status.lastPhotoDate ? daysBetween(status.lastPhotoDate, today) : "no lastPhotoDate synced",
          daysSinceLastWaist: status.lastWaistDate ? daysBetween(status.lastWaistDate, today) : "no lastWaistDate synced",
          daysSinceLastBloodTest: status.lastBloodTestDate ? daysBetween(status.lastBloodTestDate, today) : "no lastBloodTestDate synced",
        } : "no status synced yet",
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
    ctx.waitUntil(checkWeeklyImportReminder(env, false));
    ctx.waitUntil(checkLowSupply(env, false));
    ctx.waitUntil(checkGoalMilestone(env, false));
    ctx.waitUntil(checkWeeklySummaryPush(env, false));
    ctx.waitUntil(checkBloodTestReminder(env, false));
    ctx.waitUntil(checkFlaggedMarkers(env, false));
    ctx.waitUntil(checkProgressReminder(env, false));
    ctx.waitUntil(checkAdherenceDrop(env, false));
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

function currentDayOfWeek() {
  // Returns 0 (Sunday) through 6 (Saturday) in the configured timezone,
  // not the Worker's own UTC day, which can be a different calendar day.
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, weekday: "short" });
  const short = fmt.format(new Date());
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short);
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
  const supplementsRaw = await env.SUBSCRIPTIONS.get("supplements");
  const supplements = supplementsRaw ? JSON.parse(supplementsRaw) : [];
  const today = todayKey();
  const nowMin = currentMinutes();
  const windowStart = Math.floor(nowMin / WINDOW_MINUTES) * WINDOW_MINUTES;
  const windowEnd = windowStart + WINDOW_MINUTES;

  const trainingRaw = await env.SUBSCRIPTIONS.get("todayTraining");
  const trainingData = trainingRaw ? JSON.parse(trainingRaw) : null;
  const trainingType = trainingData && trainingData.date === today ? trainingData.type : null;

  const due = [];
  for (const p of [...peptides, ...supplements]) {
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

async function checkWeeklyImportReminder(env, force) {
  if (!force) {
    const dow = currentDayOfWeek();
    if (dow !== IMPORT_REMINDER_DAY) return "not the reminder day";
    const nowMin = currentMinutes();
    const { matches } = inCurrentWindow(IMPORT_REMINDER_TIME, nowMin);
    if (!matches) return "not reminder time yet";
  }

  const today = todayKey();
  if (!force) {
    const sentKey = `importReminderSent:${today}`;
    const already = await env.SUBSCRIPTIONS.get(sentKey);
    if (already) return "import reminder already sent today";
    await env.SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 86400 });
  }

  const title = "Weekly data check-in";
  const body = "Time to import last week's data: MyFitnessPal, Renpho, and Fitbit/Google Health.";

  return sendPush(env, title, body);
}

const LOW_SUPPLY_THRESHOLD = 3;
const BLOOD_TEST_REMINDER_DAYS = 90;
const PHOTO_REMINDER_DAYS = 14;
const WEEKLY_SUMMARY_TIME = "18:00";
const FLAGGED_MARKERS_TIME = "18:15";
const ADHERENCE_DROP_TIME = "18:30";
const WEEKLY_CHECK_DAY = 0; // Sunday, matching the other weekly notifications

async function getStatus(env) {
  const raw = await env.SUBSCRIPTIONS.get("status");
  return raw ? JSON.parse(raw) : {};
}

// Event-driven (not time-based): runs every cron tick, but only actually
// sends once per compound crossing the threshold — resets automatically
// once dosesRemaining goes back above it (e.g., after a refill).
async function checkLowSupply(env, force) {
  const peptidesRaw = await env.SUBSCRIPTIONS.get("peptides");
  const supplementsRaw = await env.SUBSCRIPTIONS.get("supplements");
  const all = [...(peptidesRaw ? JSON.parse(peptidesRaw) : []), ...(supplementsRaw ? JSON.parse(supplementsRaw) : [])];
  const low = all.filter((p) => p.dosesRemaining != null && p.dosesRemaining <= LOW_SUPPLY_THRESHOLD && p.dosesRemaining >= 0);

  const results = [];
  for (const p of low) {
    const key = `lowSupplyNotified:${p.id}`;
    const already = await env.SUBSCRIPTIONS.get(key);
    if (!force && already) continue;
    await env.SUBSCRIPTIONS.put(key, "1", { expirationTtl: 30 * 86400 });
    results.push(p);
  }
  // Clear the flag for anything that's been refilled back above the threshold,
  // so a future low-supply dip notifies again instead of staying silenced.
  for (const p of all) {
    if (p.dosesRemaining != null && p.dosesRemaining > LOW_SUPPLY_THRESHOLD) {
      await env.SUBSCRIPTIONS.delete(`lowSupplyNotified:${p.id}`);
    }
  }
  if (results.length === 0) return "nothing low on supply";

  const body = results.map((p) => `${p.name}: ${p.dosesRemaining} dose${p.dosesRemaining === 1 ? "" : "s"} left`).join("\n");
  return sendPush(env, "Running low on supply", body);
}

// Event-driven: checks whenever the app syncs status, dedup keyed to the
// specific goal so changing your target re-arms the notification.
async function checkGoalMilestone(env, force) {
  const status = await getStatus(env);
  const { goal, currentBodyFat } = status;
  if (!goal || goal.type !== "lose_fat" || goal.targetBodyFatPct == null || currentBodyFat == null) return "no active fat-loss goal";
  if (currentBodyFat > goal.targetBodyFatPct) return "goal not yet reached";

  const goalSignature = `${goal.targetBodyFatPct}`;
  const key = `goalMilestoneNotified:${goalSignature}`;
  if (!force) {
    const already = await env.SUBSCRIPTIONS.get(key);
    if (already) return "already notified for this goal";
  }
  await env.SUBSCRIPTIONS.put(key, "1");
  return sendPush(env, "Goal reached", `You've hit your ${goal.targetBodyFatPct}% body fat goal — currently at ${currentBodyFat}%.`);
}

async function checkWeeklySummaryPush(env, force) {
  if (!force) {
    if (currentDayOfWeek() !== WEEKLY_CHECK_DAY) return "not the weekly check day";
    const { matches } = inCurrentWindow(WEEKLY_SUMMARY_TIME, currentMinutes());
    if (!matches) return "not weekly summary time yet";
  }
  const today = todayKey();
  if (!force) {
    const sentKey = `weeklySummarySent:${today}`;
    const already = await env.SUBSCRIPTIONS.get(sentKey);
    if (already) return "weekly summary already sent today";
    await env.SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 86400 });
  }
  const status = await getStatus(env);
  if (!status.weeklySummaryText) return "no weekly summary data synced yet";
  return sendPush(env, "Your week in review", status.weeklySummaryText);
}

async function checkBloodTestReminder(env, force) {
  const status = await getStatus(env);
  if (!status.lastBloodTestDate) return "no blood test on file";
  const days = daysBetween(status.lastBloodTestDate, todayKey());
  if (days < BLOOD_TEST_REMINDER_DAYS) return "not overdue yet";

  const today = todayKey();
  if (!force) {
    const sentKey = `bloodReminderSent:${today}`;
    const already = await env.SUBSCRIPTIONS.get(sentKey);
    if (already) return "already reminded today";
    // Re-remind weekly once overdue, not every single day.
    const weekKey = `bloodReminderWeek:${Math.floor(days / 7)}`;
    const alreadyThisWeek = await env.SUBSCRIPTIONS.get(weekKey);
    if (alreadyThisWeek) return "already reminded this week";
    await env.SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 86400 });
    await env.SUBSCRIPTIONS.put(weekKey, "1", { expirationTtl: 8 * 86400 });
  }
  return sendPush(env, "Labs are overdue", `It's been ${days} days since your last blood test.`);
}

async function checkFlaggedMarkers(env, force) {
  if (!force) {
    if (currentDayOfWeek() !== WEEKLY_CHECK_DAY) return "not the weekly check day";
    const { matches } = inCurrentWindow(FLAGGED_MARKERS_TIME, currentMinutes());
    if (!matches) return "not flagged-markers time yet";
  }
  const today = todayKey();
  if (!force) {
    const sentKey = `flaggedMarkersSent:${today}`;
    const already = await env.SUBSCRIPTIONS.get(sentKey);
    if (already) return "already sent today";
    await env.SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 86400 });
  }
  const status = await getStatus(env);
  const flagged = status.flaggedMarkers || [];
  if (flagged.length === 0) return "nothing flagged";
  const body = flagged.map((m) => `${m.name}: ${m.value}${m.unit || ""} (${m.status})`).join("\n");
  return sendPush(env, "Blood markers outside range", body);
}

async function checkProgressReminder(env, force) {
  const status = await getStatus(env);
  const today = todayKey();
  const photoOverdue = !status.lastPhotoDate || daysBetween(status.lastPhotoDate, today) >= PHOTO_REMINDER_DAYS;
  const waistOverdue = !status.lastWaistDate || daysBetween(status.lastWaistDate, today) >= PHOTO_REMINDER_DAYS;
  if (!photoOverdue && !waistOverdue) return "not overdue yet";

  if (!force) {
    const sentKey = `progressReminderSent:${today}`;
    const already = await env.SUBSCRIPTIONS.get(sentKey);
    if (already) return "already reminded today";
    const weekKey = `progressReminderWeek:${Math.floor(Date.parse(today) / (7 * 86400000))}`;
    const alreadyThisWeek = await env.SUBSCRIPTIONS.get(weekKey);
    if (alreadyThisWeek) return "already reminded this week";
    await env.SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 86400 });
    await env.SUBSCRIPTIONS.put(weekKey, "1", { expirationTtl: 8 * 86400 });
  }
  const parts = [];
  if (photoOverdue) parts.push("a progress photo");
  if (waistOverdue) parts.push("your waist measurement");
  return sendPush(env, "Progress check-in", `Time to log ${parts.join(" and ")} — it's been ${PHOTO_REMINDER_DAYS}+ days.`);
}

async function checkAdherenceDrop(env, force) {
  if (!force) {
    if (currentDayOfWeek() !== WEEKLY_CHECK_DAY) return "not the weekly check day";
    const { matches } = inCurrentWindow(ADHERENCE_DROP_TIME, currentMinutes());
    if (!matches) return "not adherence-check time yet";
  }
  const today = todayKey();
  if (!force) {
    const sentKey = `adherenceDropSent:${today}`;
    const already = await env.SUBSCRIPTIONS.get(sentKey);
    if (already) return "already sent today";
    await env.SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 86400 });
  }
  const status = await getStatus(env);
  const adherence = status.adherence || [];
  const dropped = adherence.filter((c) => c.eligible > 0 && c.taken / c.eligible < 0.7);
  if (dropped.length === 0) return "no adherence drops";
  const body = dropped.map((c) => `${c.name}: ${c.taken}/${c.eligible} this week`).join("\n");
  return sendPush(env, "Adherence dropped this week", body);
}
 

