# Relay de Web Push (opcional — instantâneo)

O navegador **não consegue** enviar notificação push direto para o celular de outra pessoa (o Chrome/FCM bloqueia por CORS). Sem um “relay”, o app coloca o aviso numa fila e o **GitHub Actions** entrega a cada ~5 minutos.

Para entrega **na hora**, publique este Worker:

1. Entre em https://dash.cloudflare.com (conta gratuita)
2. **Workers & Pages** → **Create** → **Create Worker**
3. Apague o código padrão e cole o conteúdo de `worker.js`
4. **Deploy**
5. Copie a URL (algo como `https://despesas-push.SEU_SUBDOMINIO.workers.dev`)
6. Em `js/firebase-config.js`, preencha:
   ```js
   relayUrl: "https://despesas-push.SEU_SUBDOMINIO.workers.dev",
   ```
7. Faça commit/push do `firebase-config.js`

Depois disso, cada lançamento tenta o relay na hora; se falhar, continua na fila do Actions.
