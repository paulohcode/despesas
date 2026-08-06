/**
 * Cloudflare Worker — relay de Web Push (envio instantâneo com o app fechado).
 *
 * Como publicar (2 minutos, conta gratuita):
 * 1. https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. Cole este arquivo inteiro → Deploy
 * 3. Copie a URL (ex.: https://despesas-push.SEU_USER.workers.dev)
 * 4. Cole em js/firebase-config.js → VAPID_CONFIG.relayUrl
 *
 * O navegador NÃO consegue falar direto com FCM (CORS). Este Worker faz o POST.
 */
import { buildPushPayload } from "https://esm.sh/@block65/webcrypto-web-push@1.0.2";

const ALLOWED_ORIGINS = [
  "https://paulohcode.github.io",
  "http://localhost",
  "http://127.0.0.1",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.some((o) => (origin || "").startsWith(o))
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    try {
      const data = await request.json();
      const subscription = data.subscription;
      const vapid = data.vapid;
      if (!subscription?.endpoint || !vapid?.publicKey || !vapid?.privateKey) {
        return new Response(JSON.stringify({ error: "subscription/vapid required" }), {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      const payloadJson = JSON.stringify({
        title: data.title || "Despesas",
        body: data.body || "",
        tag: data.tag || "despesas",
      });

      const init = await buildPushPayload(
        {
          data: payloadJson,
          options: { ttl: 60 * 60, urgency: "high" },
        },
        subscription,
        {
          subject: vapid.subject || "mailto:familia@despesas.local",
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        }
      );

      const res = await fetch(subscription.endpoint, init);
      const text = await res.text().catch(() => "");
      return new Response(
        JSON.stringify({ ok: res.ok || res.status === 201, status: res.status, body: text.slice(0, 200) }),
        {
          status: res.ok || res.status === 201 ? 200 : 502,
          headers: { ...headers, "Content-Type": "application/json" },
        }
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err?.message || err) }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  },
};
