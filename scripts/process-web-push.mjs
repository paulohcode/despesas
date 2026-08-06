/**
 * Processa a fila de Web Push no Firebase RTDB.
 * Roda no GitHub Actions (a cada ~5 min) — o navegador não consegue
 * enviar push direto (CORS bloqueia FCM/Mozilla).
 */
import webpush from "web-push";

const DB =
  process.env.FIREBASE_DB_URL ||
  "https://despesas-9975a-default-rtdb.firebaseio.com";
const CASA = process.env.CASA_CODIGO || "familia-silva";
const VAPID_PUBLIC =
  process.env.VAPID_PUBLIC ||
  "BG2b_t6xhdHhtLQXBkRsTf4GABLK3VQlEbB1dMqfxs2iG9pNf36G5LSqyuC0lgCXpxCUEbqh7SBOiygLZrlh5IE";
const VAPID_PRIVATE =
  process.env.VAPID_PRIVATE || "O76VIkK95TTi9msz9Iz1OTbb_LNbLRnPdY4rmZ9vjLI";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:familia-silva@despesas.local";
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

async function rtdb(path, { method = "GET", body } = {}) {
  const url = `${DB.replace(/\/$/, "")}/${path.replace(/^\//, "")}.json`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RTDB ${method} ${path}: ${res.status} ${text}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  const queue = (await rtdb(`casas/${CASA}/pushQueue`)) || {};
  const ids = Object.keys(queue);
  if (!ids.length) {
    console.log("Fila vazia.");
    return;
  }

  console.log(`Processando ${ids.length} item(ns)…`);
  let ok = 0;
  let fail = 0;

  for (const id of ids) {
    const job = queue[id];
    if (!job?.subscription?.endpoint) {
      await rtdb(`casas/${CASA}/pushQueue/${id}`, { method: "DELETE" });
      fail++;
      continue;
    }
    const age = Date.now() - (Number(job.createdAt) || 0);
    if (age > MAX_AGE_MS) {
      await rtdb(`casas/${CASA}/pushQueue/${id}`, { method: "DELETE" });
      fail++;
      continue;
    }

    const payload = JSON.stringify({
      title: job.title || "Despesas",
      body: job.body || "",
      tag: job.tag || id,
    });

    try {
      const result = await webpush.sendNotification(job.subscription, payload, {
        TTL: 60 * 60,
        urgency: "high",
      });
      console.log(`OK ${id} → ${result.statusCode}`);
      ok++;
    } catch (err) {
      const status = err?.statusCode || err?.status;
      console.warn(`FAIL ${id}:`, status || err?.message || err);
      // 404/410 = inscrição inválida — remove da fila
      if (status === 404 || status === 410) {
        // keep going
      } else if (status && status >= 500) {
        // mantém na fila para tentar de novo
        fail++;
        continue;
      }
      fail++;
    }

    await rtdb(`casas/${CASA}/pushQueue/${id}`, { method: "DELETE" });
  }

  console.log(`Concluído: ${ok} ok, ${fail} falha/expirado.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
