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

/** Chaves Web Push (VAPID) — permitem avisar o celular com o app fechado */
window.VAPID_CONFIG = {
  publicKey: "BG2b_t6xhdHhtLQXBkRsTf4GABLK3VQlEbB1dMqfxs2iG9pNf36G5LSqyuC0lgCXpxCUEbqh7SBOiygLZrlh5IE",
  privateKey: "O76VIkK95TTi9msz9Iz1OTbb_LNbLRnPdY4rmZ9vjLI",
  subject: "mailto:familia-silva@despesas.local",
};
