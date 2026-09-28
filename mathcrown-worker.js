/**
 * MathCrown API Worker  (v5 - live Stripe subscriptions)
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
const STRIPE_PRICE_IDS = new Set([
  "price_1UKVH7LlOQQZLBNdBThtj49C", // premium
  "price_1UKVHiLlOQQZLBNdHTvpA3g4", // family
  "price_1UKVIFLlOQQZLBNdSAoLQpRZ"  // max
]);
const STRIPE_TRIAL_DAYS = 14;

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

    // 4. Create the subscription with a 14-day trial
    const sub = await stripeRequest(env, "POST", "/subscriptions", {
      customer: customerId,
      "items[0][price]": planId,
      trial_period_days: STRIPE_TRIAL_DAYS,
      payment_behavior: "default_incomplete",
      "expand[]": "latest_invoice.payment_intent"
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "mathcrown-api", version: 4 }, 200, origin);
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
