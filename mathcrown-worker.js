/**
 * MathCrown API Worker  (v6 - + Stripe webhook keeps plan in sync server-side)
 * Secure server-side proxy for the Axiom AI tutor, plus subscription checkout.
 */

const ALLOWED_ORIGINS = [
  "https://mymathcrown.com",
  "https://www.mymathcrown.com"
];

const MAX_TOKENS_LIMIT = 1200;
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

// Partial update — only ever touches the `plan` field on users/{uid},
// via Firestore's updateMask so nothing else on the document is disturbed.
async function setUserPlan(env, uid, planKey) {
  if (!uid) return;
  const token = await getFirestoreAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=plan`;
  await fetch(url, {
    method: "PATCH",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { plan: { stringValue: planKey } } })
  });
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
    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const uid = sub.metadata && sub.metadata.uid;
      const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
      const mappedPlan = PRICE_ID_TO_PLAN[priceId] || "free";
      const plan = PLAN_RETAINING_STATUSES.has(sub.status) ? mappedPlan : "free";
      if (uid) await setUserPlan(env, uid, plan);
    } else if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const uid = sub.metadata && sub.metadata.uid;
      if (uid) await setUserPlan(env, uid, "free");
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "mathcrown-api", version: 6 }, 200, origin);
    }

    // Stripe calls this server-to-server — no browser Origin header, so it
    // must be handled before the ALLOWED_ORIGINS check below rejects it.
    // Its own HMAC signature check (verifyStripeSignature) is what actually
    // guards this route, not CORS/origin.
    if (url.pathname === "/stripe-webhook" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }

    // ── KEY DIAGNOSTIC ──────────────────────────────────────────
    // Reports the SHAPE of the key only. Never returns the key itself.
    if (url.pathname === "/keycheck") {
      const raw = env.ANTHROPIC_API_KEY;
      if (!raw) {
        return json({
          keyFound: false,
          problem: "ANTHROPIC_API_KEY secret is not set on this Worker."
        }, 200, origin);
      }
      const trimmed = raw.trim();
      return json({
        keyFound: true,
        rawLength: raw.length,
        trimmedLength: trimmed.length,
        hasWhitespace: raw.length !== trimmed.length,
        correctPrefix: trimmed.startsWith("sk-ant-"),
        prefixSeen: trimmed.slice(0, 12),
        expectedLengthRange: "roughly 100-115 characters",
        looksTruncated: trimmed.length < 90
      }, 200, origin);
    }

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env, origin);
    }

    if (url.pathname !== "/ai" || request.method !== "POST") {
      return json({ error: "Not found" }, 404, origin);
    }

    const apiKey = (env.ANTHROPIC_API_KEY || "").trim();   // auto-trim whitespace
    if (!apiKey) {
      return json({ error: "Server is missing its API key." }, 500, origin);
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
      model: payload.model || "claude-sonnet-4-5",
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

      if (!upstream.ok) {
        const msg = (data && data.error && data.error.message) || "Upstream error";
        return json({ error: msg, status: upstream.status }, upstream.status, origin);
      }
      return json(data, 200, origin);
    } catch (err) {
      return json({ error: "Request failed: " + (err.message || "unknown") }, 502, origin);
    }
  }
};
