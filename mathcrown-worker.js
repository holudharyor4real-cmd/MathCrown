/**
 * MathCrown API Worker  (v10 - AI replies no longer expose provider details)
 * Secure server-side proxy for the Axiom AI tutor, plus subscription checkout.
 */

const ALLOWED_ORIGINS = [
  "https://mymathcrown.com",
  "https://www.mymathcrown.com"
];

const MAX_TOKENS_LIMIT = 1200;
// The tutor's model is fixed here, never chosen by the browser, so the
// page doesn't reveal which AI provider powers Axiom and a client can't
// switch to a pricier model.
const AI_MODEL = "claude-sonnet-4-6";
const AI_BUSY_MESSAGE = "Axiom is busy right now. Please try again in a moment.";
const MAX_PROMPT_CHARS = 4000;

// ── STRIPE ── LIVE MODE ─────────────────────────────────────────
// Same live price IDs as index.html's STRIPE_PLANS. The Worker never
// trusts a client-supplied price for a charge, so a subscription
// request for anything outside this allowlist is rejected before it
// ever reaches Stripe. This list is only half of going live — the
// STRIPE_SECRET_KEY Worker secret (Settings → Variables and Secrets)
// must also be set to its sk_live_... value, done directly in the
// Cloudflare dashboard, never checked into this file.
const PRICE_ID_TO_PLAN = {
  "price_1UKVH7LlOQQZLBNdBThtj49C": "premium",
  "price_1UKVHiLlOQQZLBNdHTvpA3g4": "family",
  "price_1UKVIFLlOQQZLBNdSAoLQpRZ": "max"
};
const STRIPE_PRICE_IDS = new Set(Object.keys(PRICE_ID_TO_PLAN));
const STRIPE_TRIAL_DAYS = 14;
const FIREBASE_PROJECT_ID = "mathchamp-adbd6";

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}

// ── STRIPE REST HELPER ──────────────────────────────────────────
// Stripe's stable API takes application/x-www-form-urlencoded, including
// for nested params via bracket-notation keys (e.g. "items[0][price]").
// No SDK/build step, consistent with the rest of this Worker.
async function stripeRequest(env, method, path, params) {
  const key = (env.STRIPE_SECRET_KEY || "").trim();
  const opts = {
    method,
    headers: { "Authorization": "Bearer " + key }
  };
  let url = "https://api.stripe.com/v1" + path;
  const body = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach(item => body.append(k, item));
      else body.append(k, String(v));
    }
  }
  if (method === "GET") {
    const qs = body.toString();
    if (qs) url += "?" + qs;
  } else {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = body.toString();
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function handleSubscribe(request, env, origin) {
  const secretKey = (env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey) return json({ error: "Server is missing its Stripe secret key." }, 500, origin);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400, origin);
  }

  const paymentMethodId = payload && payload.paymentMethodId;
  const email = payload && payload.email;
  const name = payload && payload.name;
  const planId = payload && payload.planId;
  const uid = payload && payload.uid;

  if (!paymentMethodId || !email || !name || !planId) {
    return json({ error: "paymentMethodId, email, name, and planId are required" }, 400, origin);
  }
  if (!STRIPE_PRICE_IDS.has(planId)) {
    return json({ error: "Unknown plan" }, 400, origin);
  }

  try {
    // 1. Find or create the Stripe customer by email
    const lookup = await stripeRequest(env, "GET", "/customers", { email, limit: 1 });
    if (!lookup.ok) {
      return json({ error: (lookup.data.error && lookup.data.error.message) || "Stripe lookup failed" }, lookup.status, origin);
    }

    let customerId = lookup.data.data && lookup.data.data[0] && lookup.data.data[0].id;
    if (!customerId) {
      const created = await stripeRequest(env, "POST", "/customers", {
        email: email, name: name, "metadata[uid]": uid || ""
      });
      if (!created.ok) {
        return json({ error: (created.data.error && created.data.error.message) || "Could not create customer" }, created.status, origin);
      }
      customerId = created.data.id;
    }

    // 2. Attach the payment method to the customer
    const attached = await stripeRequest(env, "POST", "/payment_methods/" + paymentMethodId + "/attach", { customer: customerId });
    if (!attached.ok) {
      return json({ error: (attached.data.error && attached.data.error.message) || "Could not attach card" }, attached.status, origin);
    }

    // 3. Make it the default for future invoices
    const updated = await stripeRequest(env, "POST", "/customers/" + customerId, {
      "invoice_settings[default_payment_method]": paymentMethodId
    });
    if (!updated.ok) {
      return json({ error: (updated.data.error && updated.data.error.message) || "Could not update customer" }, updated.status, origin);
    }

    // 4. Create the subscription with a 14-day trial. metadata[uid] rides
    // along on every customer.subscription.* webhook event afterward, so
    // the webhook handler below can update the right Firestore user
    // without a second Stripe API round-trip.
    const sub = await stripeRequest(env, "POST", "/subscriptions", {
      customer: customerId,
      "items[0][price]": planId,
      trial_period_days: STRIPE_TRIAL_DAYS,
      payment_behavior: "default_incomplete",
      "expand[]": "latest_invoice.payment_intent",
      "metadata[uid]": uid || ""
    });
    if (!sub.ok) {
      return json({ error: (sub.data.error && sub.data.error.message) || "Could not create subscription" }, sub.status, origin);
    }

    const s = sub.data;
    const clientSecret = (s.latest_invoice && s.latest_invoice.payment_intent)
      ? s.latest_invoice.payment_intent.client_secret
      : null;

    return json({ status: s.status, clientSecret: clientSecret, subscriptionId: s.id }, 200, origin);
  } catch (err) {
    return json({ error: "Subscribe failed: " + (err.message || "unknown") }, 502, origin);
  }
}

// ── STRIPE WEBHOOK ── keeps users/{uid}.plan server-authoritative ───
// Before this, the client set its own `plan` field the instant checkout
// looked successful and NOTHING ever corrected it afterward — a failed
// renewal or a cancellation in Stripe left the account on Premium forever.
// This endpoint listens for the subscription's real status and writes the
// correction straight to Firestore, no client involved.

function base64UrlEncode(bytes) {
  const str = typeof bytes === "string" ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Verifies Stripe's HMAC-SHA256 webhook signature so this endpoint only
// ever acts on requests that actually came from Stripe — anyone who found
// this URL otherwise could set their own account to "max" for free.
// Format: header is "t=<timestamp>,v1=<hex signature>"; the signed
// payload is "<timestamp>.<raw body>". Docs: stripe.com/docs/webhooks/signatures
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  sigHeader.split(",").forEach((p) => {
    const [k, v] = p.split("=");
    if (k && v) parts[k] = v;
  });
  if (!parts.t || !parts.v1) return false;
  // Reject anything older than 5 minutes to block replayed requests.
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${rawBody}`));
  const expected = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

let _fsTokenCache = { token: null, exp: 0 };

// Mints a short-lived Google OAuth2 access token from the Firebase service
// account (JWT-bearer flow) so this Worker can write to Firestore with no
// SDK/build step, same "no dependencies" approach as stripeRequest above.
async function getFirestoreAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_fsTokenCache.token && _fsTokenCache.exp > now + 60) return _fsTokenCache.token;

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const enc = (obj) => base64UrlEncode(JSON.stringify(obj));
  const unsigned = `${enc(header)}.${enc(claim)}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", pemToArrayBuffer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64UrlEncode(sigBuffer)}`;

  _subrequests++;
  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Firestore auth failed: " + JSON.stringify(data));
  _fsTokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return data.access_token;
}

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// uids go straight into Firestore REST paths, so anything that isn't a
// plain Firebase-style id (e.g. containing "/" or "..") is rejected.
function isValidUid(uid) {
  return typeof uid === "string" && /^[A-Za-z0-9]{10,128}$/.test(uid);
}

async function fsFetch(env, path, opts) {
  const token = await getFirestoreAccessToken(env);
  _subrequests++;
  return fetch(FS_BASE + path, {
    ...opts,
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }
  });
}

async function fsGetDoc(env, path) {
  const res = await fsFetch(env, path, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read ${path} failed: ${res.status}`);
  return res.json();
}

function fsStr(doc, field) {
  return (doc && doc.fields && doc.fields[field] && doc.fields[field].stringValue) || "";
}

// Partial update via updateMask, so only the listed fields change. With
// mustExist, a missing document is skipped instead of being created (a
// stale parent link must never conjure up a half-empty users/{uid} doc).
async function fsPatch(env, path, fields, mustExist) {
  const params = Object.keys(fields).map((f) => "updateMask.fieldPaths=" + encodeURIComponent(f));
  if (mustExist) params.push("currentDocument.exists=true");
  const body = { fields: {} };
  for (const [k, v] of Object.entries(fields)) {
    body.fields[k] = (v && v.timestamp) ? { timestampValue: v.timestamp } : toFs(v);
  }
  const res = await fsFetch(env, path + "?" + params.join("&"), { method: "PATCH", body: JSON.stringify(body) });
  if (res.ok) return true;
  if (mustExist && res.status === 404) return false;
  throw new Error(`Firestore write ${path} failed: ${res.status}`);
}

// planSource records WHO is paying for a users/{uid}.plan: "self" for the
// account's own subscription, or the paying parent's uid. That's what
// lets a parent's cancellation downgrade only the children it covered,
// never a child who has their own subscription.
async function setUserPlan(env, uid, planKey, planSource) {
  await fsPatch(env, `/users/${uid}`, { plan: planKey, planSource: planSource }, true);
}

// entitlements/{uid} is the server's own record of what a payer is
// actually paying for. Only this Worker writes it (there's no client rule
// for the collection, so Firestore denies all client access by default),
// unlike users/{uid}.plan, which the account owner can write themselves.
async function setEntitlement(env, uid, plan, status) {
  await fsPatch(env, `/entitlements/${uid}`, { plan, status: status || "", updatedAt: { timestamp: new Date().toISOString() } }, false);
}

const PLAN_CHILD_LIMITS = { premium: 1, family: 4, max: 4 };

// Applies a payer's plan to the children they've linked (parent_links/
// {payerUid}/children), earliest-linked first, up to the plan's child
// limit. Children past the limit, or every child once the plan is "free",
// fall back to free — but only if THIS payer was the one covering them.
// Returns the uids now covered.
async function propagatePlanToChildren(env, payerUid, plan) {
  const res = await fsFetch(env, `/parent_links/${payerUid}/children?pageSize=50`, { method: "GET" });
  if (!res.ok) throw new Error(`Could not list linked children: ${res.status}`);
  const data = await res.json();
  const links = (data.documents || []).slice().sort((a, b) => (a.createTime || "").localeCompare(b.createTime || ""));
  const limit = PLAN_CHILD_LIMITS[plan] || 0;
  const covered = [];
  for (const link of links) {
    const childUid = link.name.split("/").pop();
    if (!isValidUid(childUid) || childUid === payerUid) continue;
    const child = await fsGetDoc(env, `/users/${childUid}`);
    if (!child) continue;
    const childSource = fsStr(child, "planSource");
    if (childSource === "self" && (fsStr(child, "plan") || "free") !== "free") continue;
    if (covered.length < limit) {
      if (await fsPatch(env, `/users/${childUid}`, { plan, planSource: payerUid }, true)) covered.push(childUid);
    } else if (childSource === payerUid) {
      await fsPatch(env, `/users/${childUid}`, { plan: "free", planSource: "" }, true);
    }
  }
  return covered;
}

async function applyPayerPlan(env, uid, plan, status) {
  await setEntitlement(env, uid, plan, status);
  if (plan !== "free") {
    await setUserPlan(env, uid, plan, "self");
  } else {
    // Don't downgrade an account that a parent is still covering.
    const payer = await fsGetDoc(env, `/users/${uid}`);
    const source = fsStr(payer, "planSource");
    if (!source || source === "self") await setUserPlan(env, uid, "free", "");
  }
  await propagatePlanToChildren(env, uid, plan);
}

// Subscription states where the account should keep its paid plan —
// "past_due" is included deliberately: Stripe is still retrying the
// charge (dunning), so an account isn't cut off the moment one payment
// attempt fails, only once Stripe gives up (status becomes "canceled" or
// "unpaid", or a customer.subscription.deleted event arrives).
const PLAN_RETAINING_STATUSES = new Set(["active", "trialing", "past_due"]);

async function handleStripeWebhook(request, env) {
  // Signature verification needs the exact raw bytes Stripe signed —
  // must read as text before any JSON parsing touches the body.
  const rawBody = await request.text();
  const sig = request.headers.get("Stripe-Signature");
  const secret = (env.STRIPE_WEBHOOK_SECRET || "").trim();

  if (!secret) return new Response(JSON.stringify({ error: "Server is missing its webhook secret." }), { status: 500 });
  const validSig = await verifyStripeSignature(rawBody, sig, secret);
  if (!validSig) return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 400 });

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  try {
    const isSubEvent = event.type === "customer.subscription.created"
      || event.type === "customer.subscription.updated"
      || event.type === "customer.subscription.deleted";
    if (isSubEvent) {
      const sub = event.data.object;
      const uid = sub.metadata && sub.metadata.uid;
      if (isValidUid(uid)) {
        let plan = "free";
        if (event.type !== "customer.subscription.deleted") {
          const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
          plan = PLAN_RETAINING_STATUSES.has(sub.status) ? (PRICE_ID_TO_PLAN[priceId] || "free") : "free";
        }
        await applyPayerPlan(env, uid, plan, sub.status);
      }
    }
  } catch (err) {
    // Stripe retries on non-2xx, and a bad retry loop is worse than one
    // missed update — acknowledge receipt either way, but surface the
    // failure in the response body for whoever checks the Stripe
    // Dashboard's webhook delivery log.
    return new Response(JSON.stringify({ received: true, warning: err.message }), { status: 200 });
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
}

// Re-applies a parent's current plan to their linked children. Needed
// because no Stripe event fires when a parent links a child AFTER they
// already subscribed — the site calls this right after linking and on
// each Parent Dashboard visit. It's safe without a login check: it only
// ever re-applies what the server-written entitlements/{uid} doc already
// says the parent pays for, never a plan the caller supplies.
async function handleSyncEntitlements(request, env, origin) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400, origin);
  }
  const parentUid = payload && payload.parentUid;
  if (!isValidUid(parentUid)) return json({ error: "parentUid required" }, 400, origin);
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return json({ error: "Server is missing its Firebase credentials." }, 500, origin);
  try {
    const ent = await fsGetDoc(env, `/entitlements/${parentUid}`);
    const plan = fsStr(ent, "plan") || "free";
    const covered = await propagatePlanToChildren(env, parentUid, plan);
    return json({ plan, known: !!ent, covered }, 200, origin);
  } catch (err) {
    return json({ error: "Sync failed: " + err.message }, 502, origin);
  }
}

// ══ EARN WHILE YOU LEARN ════════════════════════════════════════
// Real rewards are earned through verified mastery, never bought with
// MathCoins and never decided by chance. Every payout is capped here, on
// the server, so the business's reward cost per subscriber is known in
// advance:
//   • Season Reward — a paid student who completes SEASON_WEEKS_REQUIRED
//     Weekly Goals in a season AND passes a server-graded Mastery Check
//     can claim one $5 reward. The PAYER's plan caps how many children's
//     rewards it covers per season (SEASON_REWARD_SLOTS).
//   • Weekly Champions — per division, one Top Scorer and one Most
//     Improved each week. Open to every player, free or paid (no purchase
//     necessary). Winners also pass a Mastery Check before claiming.
// Claims land in redemption_requests for parent approval and are then
// fulfilled by hand, same as before. Only this Worker writes the claim
// records (mastery_checks, mastery_passes, mastery_attempts,
// reward_claims have no client rules, so Firestore denies clients).

// The public Firebase web API key (same one index.html ships) — used only
// to ask Google to validate a caller's ID token.
const FIREBASE_WEB_API_KEY = "AIzaSyBPSvyqDq5Rl-2omowIqo86OGvrJdrP-no";

// First week whose results pay real prizes (Season 1 = 2026-Q4). Earlier
// weeks still show standings, but are practice only.
const REWARDS_START_WEEK = "2026-10-05";
const REWARD_VALUE_LABEL = "$5 value";
const SEASON_WEEKS_REQUIRED = 8;
const SEASON_REWARD_SLOTS = { premium: 1, family: 2, max: 2 };
const MASTERY_QUESTIONS = 10;
const MASTERY_PASS_SCORE = 8;
const MASTERY_TIME_LIMIT_MS = 15 * 60 * 1000;
const MASTERY_DAILY_ATTEMPTS = 3;
const MASTERY_PASS_VALID_MS = { season: 14 * 864e5, weekly: 7 * 864e5 };
const WEEKLY_MIN_ANSWERS = 30;
const WEEKLY_MIN_ACCURACY = 0.6;
const WEEKLY_MAX_ANSWERS = 3000;   // anything above this is treated as tampered
const WEEKLY_MIN_GAIN = 0.05;
const REWARD_CHOICES = {
  supplies: "School Supplies Kit",
  target: "$5 Target eGift Card",
  amazon: "$5 Amazon eGift Card"
};

// Weeks run Monday–Sunday on a fixed US Eastern (UTC-5) clock, and a
// season is the calendar quarter that week's Monday falls in. index.html
// computes the same ids with the same math, so client and server agree.
const MC_TZ_OFFSET_MS = -5 * 3600 * 1000;
function weekIdFor(ms) {
  const d = new Date((ms === undefined ? Date.now() : ms) + MC_TZ_OFFSET_MS);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}
function prevWeekId(weekId) {
  return new Date(Date.parse(weekId + "T00:00:00Z") - 7 * 864e5).toISOString().slice(0, 10);
}
function seasonIdForWeek(weekId) {
  const [y, m] = weekId.split("-").map(Number);
  return y + "-Q" + (Math.floor((m - 1) / 3) + 1);
}
function isWeekId(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && weekIdFor(Date.parse(s + "T12:00:00Z") - MC_TZ_OFFSET_MS) === s;
}

function divisionFor(grade) {
  const g = String(grade || "").trim().toUpperCase();
  if (g === "K") return "k5";
  const n = parseInt(g, 10);
  if (isNaN(n)) return "";
  if (n <= 5) return "k5";
  if (n <= 8) return "68";
  return "912";
}

// ── Firestore value helpers (typed, beyond fsPatch's strings) ──
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === "object") {
    const fields = {};
    for (const [k, x] of Object.entries(v)) fields[k] = toFs(x);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
function fromFs(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFs);
  if ("mapValue" in v) {
    const o = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = fromFs(x);
    return o;
  }
  return null;
}
function fsData(doc) {
  const o = {};
  if (doc && doc.fields) for (const [k, v] of Object.entries(doc.fields)) o[k] = fromFs(v);
  return o;
}
function fsFields(data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = toFs(v);
  return fields;
}

// Create-only write: true if created, false if the doc already exists.
// This is what makes every reward cap atomic — two simultaneous claims
// for the same slot can't both succeed.
async function fsCreate(env, collection, docId, data) {
  const res = await fsFetch(env, `/${collection}?documentId=${encodeURIComponent(docId)}`, {
    method: "POST", body: JSON.stringify({ fields: fsFields(data) })
  });
  if (res.ok) return true;
  if (res.status === 409) return false;
  throw new Error(`Firestore create ${collection}/${docId} failed: ${res.status}`);
}
async function fsSet(env, path, data) {
  const res = await fsFetch(env, path, { method: "PATCH", body: JSON.stringify({ fields: fsFields(data) }) });
  if (!res.ok) throw new Error(`Firestore set ${path} failed: ${res.status}`);
}
async function fsDelete(env, path) {
  await fsFetch(env, path, { method: "DELETE" });
}
async function fsQueryEq(env, collectionId, field, value, max) {
  const res = await fsFetch(env, ":runQuery", {
    method: "POST",
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId }],
      where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: toFs(value) } },
      limit: max || 1000
    } })
  });
  if (!res.ok) throw new Error(`Firestore query ${collectionId}.${field} failed: ${res.status}`);
  const rows = await res.json();
  return (rows || []).filter((r) => r.document).map((r) => ({ id: r.document.name.split("/").pop(), data: fsData(r.document) }));
}

// ── Auth: the caller proves who they are with a Firebase ID token ──
async function verifyIdToken(idToken) {
  if (typeof idToken !== "string" || idToken.length < 100 || idToken.length > 4096) return null;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Referer": "https://mymathcrown.com/" },
    body: JSON.stringify({ idToken })
  });
  if (!res.ok) return null;
  const data = await res.json();
  const u = data && data.users && data.users[0];
  return u && isValidUid(u.localId) ? u.localId : null;
}

// Who pays for this student's plan, checked against server-only records:
// entitlements/{payer} (written only by the Stripe webhook) and, for a
// parent-covered child, the parent-owned parent_links entry. The
// client-writable users/{uid}.plan field is never trusted on its own.
async function resolvePaidPlan(env, uid, user) {
  const source = user.planSource || "";
  const payer = (!source || source === "self") ? uid : source;
  if (!isValidUid(payer)) return { plan: "free" };
  const plan = fsStr(await fsGetDoc(env, `/entitlements/${payer}`), "plan") || "free";
  if (plan === "free") return { plan: "free" };
  if (payer !== uid && !(await fsGetDoc(env, `/parent_links/${payer}/children/${uid}`))) return { plan: "free" };
  return { plan, payer };
}

// ── Mastery Check: questions generated and graded on the server ──
function rint(a, b) {
  const x = new Uint32Array(1);
  crypto.getRandomValues(x);
  return a + (x[0] % (b - a + 1));
}
function pick(arr) { return arr[rint(0, arr.length - 1)]; }
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rint(0, i); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function signed(n) { return n < 0 ? "− " + Math.abs(n) : "+ " + n; }
function paren(n) { return n < 0 ? "(" + n + ")" : String(n); }
// " + 3x", " − x", or "" for a zero coefficient — keeps polynomials readable.
function term(coef, v) {
  if (coef === 0) return "";
  const mag = Math.abs(coef) === 1 && v ? "" : String(Math.abs(coef));
  return (coef < 0 ? " − " : " + ") + mag + v;
}

// Each generator returns { q, a, wrong }: the answer plus candidate
// wrong answers (the common mistakes). makeQuestion pads with nearby
// numbers if the candidates collide.
const MASTERY_GENERATORS = {
  1: [
    () => { const a = rint(12, 89), b = rint(11, 89); return { q: `${a} + ${b} = ?`, a: a + b, wrong: [a + b + 1, a + b - 1, a + b + 10, a + b - 10] }; },
    () => { const a = rint(40, 99), b = rint(11, a - 5); return { q: `${a} − ${b} = ?`, a: a - b, wrong: [a - b + 1, a - b - 1, a - b + 10, a + b] }; },
    () => { const a = rint(2, 9), b = rint(2, 9); return { q: `${a} × ${b} = ?`, a: a * b, wrong: [a * b + a, a * b - b, a + b, (a + 1) * b] }; },
    () => { const a = rint(5, 40), c = a + rint(5, 40); return { q: `${a} + ? = ${c}`, a: c - a, wrong: [c + a, c - a + 1, c - a - 1, c - a + 10] }; },
    () => { const n = rint(3, 9), each = rint(2, 6); return { q: `${n} bags each hold ${each} apples. How many apples in all?`, a: n * each, wrong: [n + each, n * each + each, n * each - n, n * each + 1] }; }
  ],
  2: [
    () => { const a = rint(12, 49), b = rint(3, 9); return { q: `${a} × ${b} = ?`, a: a * b, wrong: [a * b + b, a * b - a, a * (b + 1), a * b + 10] }; },
    () => { const b = rint(3, 12), q = rint(3, 15); return { q: `${b * q} ÷ ${b} = ?`, a: q, wrong: [q + 1, q - 1, q + 2, b] }; },
    () => { const d = rint(5, 12), n1 = rint(1, d - 3), n2 = rint(1, d - 1 - n1); return { q: `${n1}/${d} + ${n2}/${d} = ?`, a: `${n1 + n2}/${d}`, wrong: [`${n1 + n2}/${2 * d}`, `${n1 * n2}/${d}`, `${n1 + n2 + 1}/${d}`, `${Math.abs(n1 - n2)}/${d}`] }; },
    () => { const a = rint(11, 89), b = rint(11, 89); const s = (a + b) / 10; return { q: `${(a / 10).toFixed(1)} + ${(b / 10).toFixed(1)} = ?`, a: s.toFixed(1), wrong: [(s + 0.1).toFixed(1), (s - 0.1).toFixed(1), (s + 1).toFixed(1), (s - 1).toFixed(1)] }; },
    () => { const l = rint(4, 15), w = rint(3, 12); return { q: `A rectangle is ${l} cm long and ${w} cm wide. What is its area in cm²?`, a: l * w, wrong: [2 * (l + w), l + w, l * w + l, l * w - w] }; }
  ],
  3: [
    () => { const a = rint(-20, 20), b = rint(-20, -1); return { q: `${a} + ${paren(b)} = ?`, a: a + b, wrong: [a - b, -(a + b), a + b + 1, a + b - 1] }; },
    () => { const a = rint(-9, 9), b = rint(-9, -2); return { q: `${paren(a)} × ${paren(b)} = ?`, a: a * b, wrong: [-(a * b), a + b, a * b + 1, a * b - b] }; },
    () => { const p = pick([10, 20, 25, 50, 75]), n = rint(1, 20) * 20; return { q: `What is ${p}% of ${n}?`, a: p * n / 100, wrong: [p * n / 10, n - p * n / 100, p + n / 10, p * n / 100 + 5] }; },
    () => { const x = rint(-9, 9), a = rint(2, 9), b = rint(-15, 15); return { q: `Solve for x: ${a}x ${signed(b)} = ${a * x + b}`, a: x, wrong: [-x, x + 1, x - 1, a * x] }; },
    () => { const unit = rint(2, 9), n1 = rint(2, 5), n2 = rint(6, 12); return { q: `${n1} notebooks cost $${unit * n1}. At the same price, how many dollars do ${n2} notebooks cost?`, a: unit * n2, wrong: [unit * n2 + unit, unit * n1 + n2, unit * (n2 - 1), unit * n2 - 2] }; },
    () => { const a = rint(2, 20), b = rint(2, 9), c = rint(2, 9); return { q: `${a} + ${b} × ${c} = ?`, a: a + b * c, wrong: [(a + b) * c, a + b + c, a * b + c, a + b * c + 1] }; }
  ],
  4: [
    () => { const x = rint(-8, 8); let a = rint(2, 9), c = rint(1, 9); if (a === c) a++; const b = rint(-12, 12), d = a * x + b - c * x; return { q: `Solve for x: ${a}x ${signed(b)} = ${c}x ${signed(d)}`, a: x, wrong: [-x, x + 1, x - 1, x + 2] }; },
    () => {
      // Non-zero, distinct, non-opposite roots, so every distractor differs.
      const roots = [-9, -8, -7, -6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      const r1 = pick(roots), r2 = pick(roots.filter((r) => r !== r1 && r !== -r1));
      const b = -(r1 + r2), c = r1 * r2;
      const poly = "x²" + term(b, "x") + term(c, "");
      const pair = (p, q) => `x = ${Math.min(p, q)} and x = ${Math.max(p, q)}`;
      return { q: `Solve: ${poly} = 0`, a: pair(r1, r2), wrong: [pair(-r1, -r2), pair(r1, -r2), pair(-r1, r2), pair(r1 + 1, r2 + 1)] };
    },
    () => { const m = rint(-5, 5) || 3, x1 = rint(-6, 3), x2 = x1 + rint(1, 5), y1 = rint(-8, 8), y2 = y1 + m * (x2 - x1); return { q: `What is the slope of the line through (${x1}, ${y1}) and (${x2}, ${y2})?`, a: m, wrong: [-m, m + 1, m - 1, x2 - x1] }; },
    () => { const [p, q, r] = pick([[3, 4, 5], [5, 12, 13], [8, 15, 17], [7, 24, 25]]), k = rint(1, 3); return { q: `A right triangle has legs ${p * k} and ${q * k}. How long is the hypotenuse?`, a: r * k, wrong: [(p + q) * k, r * k + 1, r * k - 1, (q + 1) * k] }; },
    () => { const a = rint(1, 4), b = rint(-6, 6), c = rint(-9, 9), x = rint(-3, 4); return { q: `If f(x) = ${a === 1 ? "" : a}x²${term(b, "x")}${term(c, "")}, what is f(${x})?`, a: a * x * x + b * x + c, wrong: [a * x * x - b * x + c, a * 2 * x + b * x + c, a * x * x + b * x - c, a * x * x + b * x + c + 1] }; }
  ],
  5: [
    () => { const a = rint(1, 5), n = rint(2, 4), k = rint(1, 3); return { q: `If f(x) = ${a === 1 ? "" : a}x^${n}, what is f′(${k})?`, a: a * n * Math.pow(k, n - 1), wrong: [a * Math.pow(k, n), a * n * Math.pow(k, n), a * (n - 1) * Math.pow(k, n - 1), n * Math.pow(k, n - 1)] }; },
    () => { const b = pick([2, 3, 5, 10]), k = rint(2, 5); return { q: `log base ${b} of ${Math.pow(b, k)} = ?`, a: k, wrong: [k + 1, k - 1, b * k, Math.pow(b, k - 1)] }; },
    () => { const a1 = rint(1, 9), d = rint(2, 6), n = rint(5, 12); return { q: `What is the sum of the first ${n} terms of the arithmetic sequence ${a1}, ${a1 + d}, ${a1 + 2 * d}, …?`, a: n * (2 * a1 + (n - 1) * d) / 2, wrong: [n * (a1 + (n - 1) * d), a1 + (n - 1) * d, n * (2 * a1 + n * d) / 2, n * (2 * a1 + (n - 1) * d) / 2 + d] }; },
    () => { const a = rint(2, 9); return { q: `lim (x→${a}) of (x² − ${a * a}) / (x − ${a}) = ?`, a: 2 * a, wrong: [a, a * a, 0, 2 * a + 1] }; },
    () => { const [q, a] = pick([["sin 30°", "1/2"], ["cos 60°", "1/2"], ["sin 90°", "1"], ["cos 0°", "1"], ["tan 45°", "1"], ["sin 0°", "0"], ["cos 90°", "0"], ["sin 60°", "√3/2"], ["cos 45°", "√2/2"]]); return { q: `${q} = ?`, a, wrong: ["0", "1/2", "1", "√3/2", "√2/2", "√3"].filter((w) => w !== a) }; },
    () => { const a = 2 * rint(1, 4), k = rint(1, 5); return { q: `∫ from 0 to ${k} of ${a}x dx = ?`, a: a * k * k / 2, wrong: [a * k * k, a * k, a * k * k / 2 + a, a] }; }
  ]
};

function bandForGrade(grade) {
  const g = String(grade || "").trim().toUpperCase();
  const n = g === "K" ? 0 : parseInt(g, 10);
  if (isNaN(n)) return 3;
  if (n <= 3) return 1;
  if (n <= 5) return 2;
  if (n <= 8) return 3;
  if (n <= 10) return 4;
  return 5;
}

function makeQuestion(gen) {
  const { q, a, wrong } = gen();
  const answer = String(a);
  const opts = [answer];
  for (const w of shuffled(wrong.map(String))) {
    if (opts.length === 4) break;
    if (!opts.includes(w)) opts.push(w);
  }
  for (let k = 2; opts.length < 4 && !isNaN(Number(answer)); k++) {
    const w = String(Number(answer) + (k % 2 ? k : -k));
    if (!opts.includes(w)) opts.push(w);
  }
  const choices = shuffled(opts);
  return { q, choices, correct: choices.indexOf(answer) };
}

function buildMasteryCheck(band) {
  const gens = MASTERY_GENERATORS[band] || MASTERY_GENERATORS[3];
  const order = [];
  while (order.length < MASTERY_QUESTIONS) order.push(...shuffled(gens));
  return order.slice(0, MASTERY_QUESTIONS).map(makeQuestion);
}

function randomId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function readAuthedJson(request, env, origin) {
  let payload;
  try { payload = await request.json(); } catch (e) { return { error: json({ error: "Invalid JSON" }, 400, origin) }; }
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return { error: json({ error: "Server is missing its Firebase credentials." }, 500, origin) };
  const uid = await verifyIdToken(payload && payload.idToken);
  if (!uid) return { error: json({ error: "Please sign in again." }, 401, origin) };
  return { uid, payload };
}

async function handleMasteryStart(request, env, origin) {
  const { uid, error } = await readAuthedJson(request, env, origin);
  if (error) return error;
  try {
    const user = fsData(await fsGetDoc(env, `/users/${uid}`));
    if (user.role && user.role !== "student") return json({ error: "Mastery Checks are for student accounts." }, 403, origin);
    const today = new Date(Date.now() + MC_TZ_OFFSET_MS).toISOString().slice(0, 10);
    const attemptsPath = `/mastery_attempts/${uid}_${today}`;
    const used = Number(fsData(await fsGetDoc(env, attemptsPath)).count || 0);
    if (used >= MASTERY_DAILY_ATTEMPTS) {
      return json({ error: `You've used all ${MASTERY_DAILY_ATTEMPTS} Mastery Checks for today — practice a bit and try again tomorrow!` }, 429, origin);
    }
    await fsSet(env, attemptsPath, { uid, count: used + 1 });
    const band = bandForGrade(user.grade);
    const qs = buildMasteryCheck(band);
    const checkId = randomId();
    const now = Date.now();
    await fsCreate(env, "mastery_checks", checkId, {
      uid, band, answers: qs.map((x) => x.correct), createdAtMs: now, expiresAtMs: now + MASTERY_TIME_LIMIT_MS, used: false
    });
    return json({
      checkId, timeLimitSec: MASTERY_TIME_LIMIT_MS / 1000, passScore: MASTERY_PASS_SCORE,
      attemptsLeft: MASTERY_DAILY_ATTEMPTS - used - 1,
      questions: qs.map((x) => ({ q: x.q, choices: x.choices }))
    }, 200, origin);
  } catch (err) {
    return json({ error: "Could not start the Mastery Check: " + err.message }, 502, origin);
  }
}

async function handleMasterySubmit(request, env, origin) {
  const { uid, payload, error } = await readAuthedJson(request, env, origin);
  if (error) return error;
  const checkId = payload.checkId;
  const picks = payload.answers;
  if (typeof checkId !== "string" || !/^[0-9a-f]{24}$/.test(checkId)) return json({ error: "checkId required" }, 400, origin);
  if (!Array.isArray(picks) || picks.length !== MASTERY_QUESTIONS) return json({ error: "answers required" }, 400, origin);
  try {
    const path = `/mastery_checks/${checkId}`;
    const check = fsData(await fsGetDoc(env, path));
    if (check.uid !== uid) return json({ error: "That Mastery Check wasn't found." }, 404, origin);
    if (check.used) return json({ error: "That Mastery Check was already submitted." }, 409, origin);
    await fsPatch(env, path, { used: true }, true);
    const late = Date.now() > Number(check.expiresAtMs || 0) + 60 * 1000;
    const answers = check.answers || [];
    let score = 0;
    answers.forEach((c, i) => { if (Number(picks[i]) === c) score++; });
    const passed = !late && score >= MASTERY_PASS_SCORE;
    if (passed) await fsSet(env, `/mastery_passes/${uid}`, { uid, score, band: check.band, passedAtMs: Date.now() });
    return json({ score, total: answers.length, passed, late, correct: answers }, 200, origin);
  } catch (err) {
    return json({ error: "Could not grade the Mastery Check: " + err.message }, 502, origin);
  }
}

async function hasRecentMasteryPass(env, uid, purpose) {
  const pass = fsData(await fsGetDoc(env, `/mastery_passes/${uid}`));
  return Date.now() - Number(pass.passedAtMs || 0) <= MASTERY_PASS_VALID_MS[purpose];
}

// Name/grade/email ride along so whoever fulfills the request can see
// who it's for; delivery itself goes to the approving parent.
function rewardRequestDoc(uid, user, choiceKey, extra) {
  return Object.assign({
    uid, name: user.name || user.displayName || "", email: user.email || "", grade: String(user.grade || ""),
    choice: choiceKey, prizeCost: 0, prizeValue: REWARD_VALUE_LABEL,
    status: "pending", requestedAt: new Date(), source: "worker"
  }, extra);
}

async function handleSeasonClaim(request, env, origin) {
  const { uid, payload, error } = await readAuthedJson(request, env, origin);
  if (error) return error;
  const choiceKey = payload.choice;
  if (!REWARD_CHOICES[choiceKey]) return json({ error: "Pick a reward first." }, 400, origin);
  try {
    const user = fsData(await fsGetDoc(env, `/users/${uid}`));
    const { plan, payer } = await resolvePaidPlan(env, uid, user);
    if (plan === "free") return json({ error: "Season Rewards come with Premium, Family and Max plans." }, 403, origin);

    const thisWeek = weekIdFor();
    const seasonId = seasonIdForWeek(thisWeek);
    if (thisWeek < REWARDS_START_WEEK) return json({ error: "Season 1 starts Monday, October 5." }, 403, origin);
    const sp = user.seasonProgress || {};
    const weeks = new Set((sp.id === seasonId && Array.isArray(sp.weeks) ? sp.weeks : [])
      .filter((w) => isWeekId(w) && w <= thisWeek && seasonIdForWeek(w) === seasonId));
    if (weeks.size < SEASON_WEEKS_REQUIRED) {
      return json({ error: `Complete ${SEASON_WEEKS_REQUIRED} Weekly Goals this season first (${weeks.size} so far).` }, 403, origin);
    }
    if (!(await hasRecentMasteryPass(env, uid, "season"))) {
      return json({ error: "Pass a Mastery Check first.", needMastery: true }, 403, origin);
    }

    const childMarker = `season_${seasonId}_child_${uid}`;
    if (!(await fsCreate(env, "reward_claims", childMarker, { uid, seasonId, createdAt: new Date() }))) {
      return json({ error: "You already claimed this season's reward — great work!" }, 409, origin);
    }
    let slot = 0;
    const slots = SEASON_REWARD_SLOTS[plan] || 0;
    for (let n = 1; n <= slots && !slot; n++) {
      if (await fsCreate(env, "reward_claims", `season_${seasonId}_payer_${payer}_${n}`, { uid, payer, plan, seasonId, createdAt: new Date() })) slot = n;
    }
    if (!slot) {
      await fsDelete(env, `/reward_claims/${childMarker}`);
      return json({ error: `Your plan's ${slots} Season Reward${slots === 1 ? "" : "s"} for this season ${slots === 1 ? "has" : "have"} already been claimed.` }, 409, origin);
    }
    const requestId = `season_${seasonId}_${uid}`;
    await fsCreate(env, "redemption_requests", requestId, rewardRequestDoc(uid, user, choiceKey, {
      type: "season", prizeName: `Season Reward: ${REWARD_CHOICES[choiceKey]}`, seasonId, payerUid: payer, plan
    }));
    return json({ ok: true, requestId, prizeName: `Season Reward: ${REWARD_CHOICES[choiceKey]}` }, 200, origin);
  } catch (err) {
    return json({ error: "Could not claim the reward: " + err.message }, 502, origin);
  }
}

// Last week's winners per division, recomputed from public_profiles with
// the same rules index.html uses to show standings. Cached briefly since
// every Rewards page visit asks for it.
let _weeklyCache = { weekId: "", at: 0, data: null };

function weeklyRow(id, d, prefix) {
  const answered = Number(d[prefix + "Answered"] || 0), correct = Number(d[prefix + "Correct"] || 0);
  if (answered < WEEKLY_MIN_ANSWERS || answered > WEEKLY_MAX_ANSWERS || correct < 0 || correct > answered) return null;
  const division = divisionFor(d.grade);
  if (!division || !isValidUid(id)) return null;
  const acc = correct / answered;
  return {
    uid: id, label: d.displayLabel || "Player", division, answered, acc,
    score: Math.round(correct * acc),
    gain: Number(d[prefix + "BaseN"] || 0) >= WEEKLY_MIN_ANSWERS ? acc - Number(d[prefix + "BaseAcc"] || 0) : null
  };
}

async function computeWeeklyWinners(env, weekId) {
  if (_weeklyCache.weekId === weekId && Date.now() - _weeklyCache.at < 5 * 60 * 1000) return _weeklyCache.data;
  const [cur, prev] = await Promise.all([
    fsQueryEq(env, "public_profiles", "wk", weekId, 1000),
    fsQueryEq(env, "public_profiles", "prevWk", weekId, 1000)
  ]);
  const rows = new Map();
  cur.forEach((r) => { const x = weeklyRow(r.id, r.data, "wk"); if (x) rows.set(x.uid, x); });
  prev.forEach((r) => { const x = weeklyRow(r.id, r.data, "prevWk"); if (x && !rows.has(x.uid)) rows.set(x.uid, x); });
  const out = {};
  for (const division of ["k5", "68", "912"]) {
    const list = [...rows.values()].filter((x) => x.division === division);
    const champ = list.filter((x) => x.acc >= WEEKLY_MIN_ACCURACY)
      .sort((a, b) => b.score - a.score || b.acc - a.acc || a.uid.localeCompare(b.uid))[0] || null;
    const improved = list.filter((x) => x.gain !== null && x.gain >= WEEKLY_MIN_GAIN && (!champ || x.uid !== champ.uid))
      .sort((a, b) => b.gain - a.gain || b.answered - a.answered || a.uid.localeCompare(b.uid))[0] || null;
    out[division] = {
      champion: champ && { uid: champ.uid, label: champ.label, score: champ.score, accuracy: Math.round(champ.acc * 100) },
      improved: improved && { uid: improved.uid, label: improved.label, gain: Math.round(improved.gain * 100), accuracy: Math.round(improved.acc * 100) }
    };
  }
  _weeklyCache = { weekId, at: Date.now(), data: out };
  return out;
}

async function handleWeeklyResults(request, env, origin) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return json({ error: "Server is missing its Firebase credentials." }, 500, origin);
  try {
    const weekId = prevWeekId(weekIdFor());
    const divisions = await computeWeeklyWinners(env, weekId);
    const claims = await fsQueryEq(env, "reward_claims", "weekId", weekId, 50);
    const claimed = claims.map((c) => c.id);
    return json({ weekId, divisions, claimed, prizeWeek: weekId >= REWARDS_START_WEEK }, 200, origin);
  } catch (err) {
    return json({ error: "Could not load weekly results: " + err.message }, 502, origin);
  }
}

async function handleWeeklyClaim(request, env, origin) {
  const { uid, payload, error } = await readAuthedJson(request, env, origin);
  if (error) return error;
  const choiceKey = payload.choice;
  if (!REWARD_CHOICES[choiceKey]) return json({ error: "Pick a reward first." }, 400, origin);
  try {
    const weekId = prevWeekId(weekIdFor());
    if (weekId < REWARDS_START_WEEK) return json({ error: "Weekly prizes start with the week of October 5 — this week is practice." }, 403, origin);
    const winners = await computeWeeklyWinners(env, weekId);
    let division = "", category = "";
    for (const [div, w] of Object.entries(winners)) {
      if (w.champion && w.champion.uid === uid) { division = div; category = "champion"; }
      else if (w.improved && w.improved.uid === uid) { division = div; category = "improved"; }
    }
    if (!category) return json({ error: "Only last week's Weekly Champions can claim this prize." }, 403, origin);
    if (!(await hasRecentMasteryPass(env, uid, "weekly"))) {
      return json({ error: "Pass a Mastery Check to verify your win first.", needMastery: true }, 403, origin);
    }
    const user = fsData(await fsGetDoc(env, `/users/${uid}`));
    const slotId = `weekly_${weekId}_${division}_${category}`;
    if (!(await fsCreate(env, "reward_claims", slotId, { uid, weekId, division, category, createdAt: new Date() }))) {
      return json({ error: "This prize was already claimed." }, 409, origin);
    }
    const label = category === "champion" ? "Weekly Top Scorer" : "Weekly Most Improved";
    await fsCreate(env, "redemption_requests", slotId, rewardRequestDoc(uid, user, choiceKey, {
      type: "weekly", prizeName: `${label}: ${REWARD_CHOICES[choiceKey]}`, weekId, division, category
    }));
    return json({ ok: true, requestId: slotId, prizeName: `${label}: ${REWARD_CHOICES[choiceKey]}` }, 200, origin);
  } catch (err) {
    return json({ error: "Could not claim the prize: " + err.message }, 502, origin);
  }
}

// ══ WEEKLY PARENT REPORT EMAIL ══════════════════════════════════
// Every Monday morning each parent gets one email summarizing last week
// for each linked child: questions answered, accuracy and how it compares
// to the child's usual, Weekly Goal, Season Mastery Path progress, streak
// and the topic that needs the most practice.
//
// Setup (Cloudflare dashboard, not this file):
//   • Secret RESEND_API_KEY — from resend.com, with mymathcrown.com
//     verified there so mail can come from reports@mymathcrown.com.
//   • Cron Trigger "0 12-23 * * 1" (hourly on Mondays from 7am ET). Each
//     run sends a batch and records lastReportWeek per parent, so later
//     runs pick up where the last one stopped; this keeps every run under
//     the Workers subrequest limit (REPORT_SUBREQUEST_BUDGET, default 45,
//     fits the free plan; raise it on Workers Paid).
//   • Optional REPORT_FROM, e.g. "MathCrown <reports@mymathcrown.com>".
// Parents opt out with the one-click link in every email or the toggle in
// their Parent Dashboard (users/{uid}.weeklyReport = false).

const SITE_URL = "https://www.mymathcrown.com";
let _subrequests = 0;

async function countedFetch(url, opts) {
  _subrequests++;
  return fetch(url, opts);
}

// Unsubscribe links are signed so nobody can opt out someone else. The
// HMAC key is derived from the service account's private key, so no
// extra secret needs managing.
async function unsubscribeToken(env, uid) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mc-unsubscribe:" + sa.private_key));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(uid));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

function firstName(full) {
  return String(full || "Your child").trim().split(/\s+/)[0] || "Your child";
}

function weekStatsFor(child, weekId) {
  if (child.week && child.week.id === weekId) return child.week;
  if (child.prevWeek && child.prevWeek.id === weekId) return child.prevWeek;
  return null;
}

function weakestTopic(topicStats) {
  let worst = null;
  for (const [topic, t] of Object.entries(topicStats || {})) {
    const attempted = Number(t && t.attempted) || 0;
    if (attempted < 5) continue;
    const acc = (Number(t.correct) || 0) / attempted;
    if (!worst || acc < worst.acc) worst = { topic, acc };
  }
  if (!worst || worst.acc >= 0.85) return null;
  return { name: worst.topic.replace(/([a-z])([A-Z0-9])/g, "$1 $2"), pct: Math.round(worst.acc * 100) };
}

// One child's numbers for the given week, from their private users doc.
function childSummary(child, weekId) {
  const w = weekStatsFor(child, weekId) || { answered: 0, correct: 0, baseAcc: 0, baseN: 0 };
  const answered = Number(w.answered) || 0, correct = Number(w.correct) || 0;
  const acc = answered ? Math.round(correct / answered * 100) : 0;
  const change = (answered >= 10 && Number(w.baseN) >= WEEKLY_MIN_ANSWERS) ? acc - Math.round(Number(w.baseAcc) * 100) : null;
  const seasonId = seasonIdForWeek(weekId);
  const sp = child.seasonProgress || {};
  const seasonDone = (sp.id === seasonId && Array.isArray(sp.weeks) ? sp.weeks : [])
    .filter((x) => isWeekId(x) && x >= REWARDS_START_WEEK && x <= weekId).length;
  return {
    name: firstName(child.name || child.displayName), answered, acc, change,
    goalMet: !!(w.goalMet || (answered >= 50 && correct / answered >= 0.75)),
    seasonDone, seasonActive: weekId >= REWARDS_START_WEEK,
    streak: Number(child.streak) || 0,
    weak: weakestTopic(child.topicStats)
  };
}

function childBlockHtml(c) {
  const stat = (big, small, color) => `<td style="padding:8px 6px;text-align:center;width:33%"><div style="font-size:22px;font-weight:800;color:${color}">${big}</div><div style="font-size:12px;color:#5b6b84">${small}</div></td>`;
  const change = c.change === null ? "—" : (c.change > 0 ? "+" : "") + c.change + "%";
  const lines = [];
  if (!c.answered) {
    lines.push(`${escHtml(c.name)} didn't practice this week. Ten minutes a day is enough to keep skills fresh: try today's Daily Crown together.`);
  } else {
    lines.push(c.goalMet ? `🎯 Weekly Goal complete (50 questions at 75%+ accuracy).` : `🎯 Weekly Goal: ${c.answered}/50 questions${c.acc < 75 ? `, accuracy ${c.acc}% (goal 75%)` : ""}.`);
  }
  if (c.seasonActive) lines.push(`🏁 Season Mastery Path: ${c.seasonDone} of ${SEASON_WEEKS_REQUIRED} Weekly Goals this season.`);
  if (c.streak > 1) lines.push(`🔥 ${c.streak}-day practice streak.`);
  if (c.weak) lines.push(`📌 Needs practice: <strong>${escHtml(c.weak.name)}</strong> (${c.weak.pct}% accuracy so far).`);
  return `<div style="border:1px solid #dfe6f1;border-radius:14px;padding:16px;margin:0 0 14px">
    <div style="font-size:18px;font-weight:800;color:#0d1f3c;margin-bottom:8px">${escHtml(c.name)}</div>
    <table role="presentation" style="width:100%;border-collapse:collapse;background:#f5f8fc;border-radius:10px"><tr>
      ${stat(c.answered, "questions", "#1c3a6e")}${stat(c.answered ? c.acc + "%" : "—", "accuracy", "#0a8f6a")}${stat(change, "vs. usual", c.change > 0 ? "#0a8f6a" : "#1c3a6e")}
    </tr></table>
    <div style="font-size:14px;color:#24344d;line-height:1.7;margin-top:10px">${lines.join("<br>")}</div>
  </div>`;
}

function childBlockText(c) {
  const parts = [`${c.name}: ${c.answered} questions, ${c.answered ? c.acc + "% accuracy" : "no practice"}` + (c.change === null ? "" : `, ${c.change > 0 ? "+" : ""}${c.change}% vs. usual`) + "."];
  if (c.answered) parts.push(c.goalMet ? "Weekly Goal complete." : `Weekly Goal: ${c.answered}/50.`);
  if (c.seasonActive) parts.push(`Season path: ${c.seasonDone}/${SEASON_WEEKS_REQUIRED}.`);
  if (c.weak) parts.push(`Needs practice: ${c.weak.name} (${c.weak.pct}%).`);
  return parts.join(" ");
}

async function buildParentReport(env, parentUid, weekId, label) {
  const res = await countedFetch(FS_BASE + `/parent_links/${parentUid}/children?pageSize=10`, {
    headers: { "Authorization": "Bearer " + await getFirestoreAccessToken(env) }
  });
  if (!res.ok) throw new Error("Could not list children: " + res.status);
  const links = ((await res.json()).documents || []).map((d) => d.name.split("/").pop()).filter(isValidUid).slice(0, 4);
  const kids = [];
  for (const childUid of links) {
    const child = fsData(await fsGetDoc(env, `/users/${childUid}`));
    if (child.role && child.role !== "student") continue;
    kids.push(childSummary(child, weekId));
  }
  if (!kids.length) return null;
  const unsub = `https://mathcrown-api.holudharyor4real.workers.dev/unsubscribe?u=${parentUid}&t=${await unsubscribeToken(env, parentUid)}`;
  const subject = kids.length === 1
    ? `${kids[0].name}'s math week: ${kids[0].answered} questions${kids[0].answered ? `, ${kids[0].acc}% accuracy` : ""}`
    : `Your kids' math week: ${kids.map((k) => `${k.name} ${k.answered}`).join(" · ")} questions`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#0d1f3c">
    <div style="font-size:22px;font-weight:800;margin-bottom:2px">👑 MathCrown Weekly Report</div>
    <div style="font-size:13px;color:#5b6b84;margin-bottom:18px">${escHtml(label)}</div>
    ${kids.map(childBlockHtml).join("")}
    <div style="text-align:center;margin:20px 0"><a href="${SITE_URL}" style="background:#ffc93c;color:#0d1f3c;font-weight:800;text-decoration:none;padding:12px 22px;border-radius:999px;display:inline-block">Open MathCrown</a></div>
    <div style="font-size:12px;color:#7a879b;line-height:1.6">You get this because you linked a child to your MathCrown parent account. MathCoins have no cash value; real rewards follow the Official Rewards Rules and always need your approval.<br><a href="${unsub}" style="color:#7a879b">Unsubscribe from weekly reports</a></div>
  </div>`;
  const text = `MathCrown Weekly Report (${label})\n\n${kids.map(childBlockText).join("\n\n")}\n\nOpen MathCrown: ${SITE_URL}\nUnsubscribe: ${unsub}`;
  return { subject, html, text, unsub };
}

async function sendEmail(env, to, report) {
  const res = await countedFetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + (env.RESEND_API_KEY || "").trim(), "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.REPORT_FROM || "MathCrown <reports@mymathcrown.com>",
      to: [to], subject: report.subject, html: report.html, text: report.text,
      headers: { "List-Unsubscribe": `<${report.unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    })
  });
  if (!res.ok) throw new Error("Email send failed: " + res.status + " " + (await res.text()).slice(0, 200));
}

function weekLabel(weekId) {
  const start = new Date(Date.parse(weekId + "T12:00:00Z"));
  const end = new Date(start.getTime() + 6 * 864e5);
  const f = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `Week of ${f(start)} – ${f(end)}`;
}

// One scheduled batch: parents who haven't had last week's report yet.
async function runWeeklyReports(env) {
  if (!env.RESEND_API_KEY || !env.FIREBASE_SERVICE_ACCOUNT_JSON) return { skipped: "missing RESEND_API_KEY or Firebase credentials" };
  _subrequests = 0;
  const budget = Number(env.REPORT_SUBREQUEST_BUDGET) || 45;
  const weekId = prevWeekId(weekIdFor());
  const parents = await fsQueryEq(env, "users", "role", "parent", 1000);
  let sent = 0, skipped = 0, failed = 0;
  for (const p of parents) {
    if (_subrequests > budget - 8) break;
    const d = p.data;
    if (d.lastReportWeek === weekId || d.weeklyReport === false || !isValidUid(p.id)) continue;
    try {
      const report = d.email ? await buildParentReport(env, p.id, weekId, weekLabel(weekId)) : null;
      if (report) { await sendEmail(env, d.email, report); sent++; } else skipped++;
      await fsPatch(env, `/users/${p.id}`, { lastReportWeek: weekId }, true);
    } catch (err) {
      failed++;
      console.log("weekly report failed for", p.id, err.message);
    }
  }
  return { weekId, sent, skipped, failed };
}

async function handleReportPreview(request, env, origin) {
  const { uid, error } = await readAuthedJson(request, env, origin);
  if (error) return error;
  if (!env.RESEND_API_KEY) return json({ error: "Weekly emails aren't switched on yet." }, 503, origin);
  try {
    const parent = fsData(await fsGetDoc(env, `/users/${uid}`));
    if (parent.role !== "parent" || !parent.email) return json({ error: "Sample reports are for parent accounts." }, 403, origin);
    const log = fsData(await fsGetDoc(env, `/report_log/${uid}`));
    if (Date.now() - Number(log.lastPreviewAtMs || 0) < 10 * 60 * 1000) {
      return json({ error: "A sample was just sent. Check your inbox (and spam folder)." }, 429, origin);
    }
    const weekId = weekIdFor();
    const report = await buildParentReport(env, uid, weekId, weekLabel(weekId) + " (so far)");
    if (!report) return json({ error: "Link a child first, then we can send a report." }, 400, origin);
    await sendEmail(env, parent.email, report);
    await fsSet(env, `/report_log/${uid}`, { lastPreviewAtMs: Date.now() });
    return json({ ok: true, to: parent.email }, 200, origin);
  } catch (err) {
    return json({ error: "Could not send the sample: " + err.message }, 502, origin);
  }
}

async function handleUnsubscribe(request, env, url) {
  const uid = url.searchParams.get("u") || "";
  const t = url.searchParams.get("t") || "";
  const page = (msg) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MathCrown</title><div style="font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;text-align:center;color:#0d1f3c"><div style="font-size:40px">👑</div><h2>${msg}</h2><p><a href="${SITE_URL}">Back to MathCrown</a></p></div>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (!isValidUid(uid) || !env.FIREBASE_SERVICE_ACCOUNT_JSON || t !== await unsubscribeToken(env, uid)) {
    return page("That unsubscribe link isn't valid. You can turn off reports in your Parent Dashboard.");
  }
  await fsPatch(env, `/users/${uid}`, { weeklyReport: false }, true);
  return page("You're unsubscribed from weekly reports. You can turn them back on in your Parent Dashboard.");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "mathcrown-api", version: 10 }, 200, origin);
    }

    // Stripe calls this server-to-server — no browser Origin header, so it
    // must be handled before the ALLOWED_ORIGINS check below rejects it.
    // Its own HMAC signature check (verifyStripeSignature) is what actually
    // guards this route, not CORS/origin.
    if (url.pathname === "/stripe-webhook" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }

    // Opened from an email (GET) or by a mail client's one-click
    // unsubscribe (POST) — neither sends a site Origin; the signed token
    // in the link is what guards it.
    if (url.pathname === "/unsubscribe") {
      return handleUnsubscribe(request, env, url);
    }

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env, origin);
    }

    if (url.pathname === "/sync-entitlements" && request.method === "POST") {
      return handleSyncEntitlements(request, env, origin);
    }

    if (request.method === "POST") {
      if (url.pathname === "/mastery-check/start") return handleMasteryStart(request, env, origin);
      if (url.pathname === "/mastery-check/submit") return handleMasterySubmit(request, env, origin);
      if (url.pathname === "/rewards/season") return handleSeasonClaim(request, env, origin);
      if (url.pathname === "/rewards/weekly") return handleWeeklyClaim(request, env, origin);
      if (url.pathname === "/rewards/weekly-results") return handleWeeklyResults(request, env, origin);
      if (url.pathname === "/weekly-report/preview") return handleReportPreview(request, env, origin);
    }

    if (url.pathname !== "/ai" || request.method !== "POST") {
      return json({ error: "Not found" }, 404, origin);
    }

    const apiKey = (env.ANTHROPIC_API_KEY || "").trim();   // auto-trim whitespace
    if (!apiKey) {
      console.log("AI key secret is not set");
      return json({ error: AI_BUSY_MESSAGE }, 500, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: "Invalid JSON" }, 400, origin);
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (!messages.length) return json({ error: "messages required" }, 400, origin);

    if (JSON.stringify(messages).length > MAX_PROMPT_CHARS) {
      return json({ error: "Prompt too long" }, 413, origin);
    }

    const body = {
      model: AI_MODEL,
      max_tokens: Math.min(payload.max_tokens || 800, MAX_TOKENS_LIMIT),
      messages: messages
    };
    // Force plain-text output - chat bubbles can't render markdown
    const PLAIN_TEXT_RULE = " IMPORTANT FORMATTING RULE: Respond in plain conversational text only. " +
      "Never use markdown. No asterisks for bold or italics, no # headings, no bullet points, " +
      "no numbered lists, no code fences, no tables. Write in flowing sentences and short paragraphs. " +
      "Mathematical expressions are fine written normally, e.g. 3/4 = 0.75 = 75%.";

    if (payload.system) {
      body.system = String(payload.system).slice(0, 2000) + PLAIN_TEXT_RULE;
    } else {
      body.system = PLAIN_TEXT_RULE.trim();
    }

    try {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      });

      const data = await upstream.json();

      // Only the reply text goes back to the browser: no model name, ids
      // or provider error messages. Details stay in the Worker logs.
      if (!upstream.ok) {
        console.log("AI upstream error", upstream.status, JSON.stringify(data && data.error));
        return json({ error: AI_BUSY_MESSAGE }, 502, origin);
      }
      const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      return json({ content: [{ type: "text", text }] }, 200, origin);
    } catch (err) {
      console.log("AI request failed", err.message);
      return json({ error: AI_BUSY_MESSAGE }, 502, origin);
    }
  },

  // Cron Trigger (see WEEKLY PARENT REPORT EMAIL above).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWeeklyReports(env).then((r) => console.log("weekly reports:", JSON.stringify(r))));
  }
};
