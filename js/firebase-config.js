/**
 * Projeto Firebase: despesas-9975a
 *
 * Regras (Realtime Database → aba Regras) — publique:
 * {
 *   "rules": {
 *     "casas": {
 *       "$codigo": {
 *         ".read": true,
 *         ".write": true
 *       }
 *     }
 *   }
 * }
 *
 * Fotos de comprovante: ImgBB (não usa Firebase Storage / Blaze).
 * 1) Crie conta em https://imgbb.com
 * 2) Gere a chave em https://api.imgbb.com/
 * 3) Cole em IMGBB_CONFIG.apiKey abaixo
 */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBqqRe2xqSWQSKhR7lxFO4Wzs8vqIBomr0",
  authDomain: "despesas-9975a.firebaseapp.com",
  databaseURL: "https://despesas-9975a-default-rtdb.firebaseio.com",
  projectId: "despesas-9975a",
  storageBucket: "despesas-9975a.firebasestorage.app",
  messagingSenderId: "849590406258",
  appId: "1:849590406258:web:3c40c9f8ab817254e746eb",
};

/** ImgBB — hospedagem das fotos de comprovante (grátis, sem Blaze) */
window.IMGBB_CONFIG = {
  apiKey: "bb930da5150db54321d06522cb044456", // cole aqui a chave de https://api.imgbb.com/
};

/** Chaves Web Push (VAPID) — permitem avisar o celular com o app fechado.
 *
 * O navegador NÃO consegue enviar push direto (CORS no FCM). Por isso:
 * 1) O app coloca o aviso numa fila no Firebase
 * 2) O GitHub Actions envia a cada ~5 min (automático após o push deste repo)
 * 3) Opcional — envio instantâneo: publique push-relay/worker.js no Cloudflare Workers
 *    e cole a URL em relayUrl abaixo (ex.: https://despesas-push.xxx.workers.dev)
 */
window.VAPID_CONFIG = {
  publicKey: "BG2b_t6xhdHhtLQXBkRsTf4GABLK3VQlEbB1dMqfxs2iG9pNf36G5LSqyuC0lgCXpxCUEbqh7SBOiygLZrlh5IE",
  privateKey: "O76VIkK95TTi9msz9Iz1OTbb_LNbLRnPdY4rmZ9vjLI",
  subject: "mailto:familia-silva@despesas.local",
  relayUrl: "", // cole aqui a URL do Cloudflare Worker (push-relay/worker.js)
};
