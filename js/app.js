(() => {
  "use strict";

  const STORAGE_KEY = "despesas_domesticas_v1";
  const SESSION_KEY = "despesas_usuario_atual";
  const CASA_KEY = "despesas_codigo_casa";
  const CASA_PADRAO = "familia-silva";
  const ADMIN_NOME = "paulo";
  const DEFAULT_PESOS = { g1: 3.0, g2: 3.0, g3: 1.8 };

  const MESES_NOME = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
  ];

  const COMPRADORES = {
    paulo: { label: "Paulo / Grupo 1", grupo: "g1" },
    outro: { label: "Outro / Grupo 1", grupo: "g1" },
    "mae-avo": { label: "Mãe-Avô / Grupo 2", grupo: "g2" },
    "irmao-cunhada": { label: "Irmão-Cunhada / Grupo 3", grupo: "g3" },
  };

  const PAGAMENTOS = {
    credito: "Crédito",
    pix: "PIX",
    dinheiro: "Dinheiro",
    debito: "Débito",
  };

  const GRUPOS = { g1: "Grupo 1", g2: "Grupo 2", g3: "Grupo 3" };

  let state = loadState();
  let usuarioAtualId = localStorage.getItem(SESSION_KEY) || null;
  let codigoCasa = localStorage.getItem(CASA_KEY) || CASA_PADRAO;
  let mesSelecionado = state.mesAtual || state.meses[0]?.id || null;
  let deferredInstallPrompt = null;
  let toastTimer = null;
  let syncRef = null;
  let syncUnsub = null;
  let applyingRemote = false;
  let pushTimer = null;
  let lastRemoteUpdatedAt = 0;
  let syncStatus = "offline"; // offline | syncing | online | error | local

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const pesos = {
        g1: Number(parsed.pesos?.g1) || DEFAULT_PESOS.g1,
        g2: Number(parsed.pesos?.g2) || DEFAULT_PESOS.g2,
        g3: Number(parsed.pesos?.g3) || DEFAULT_PESOS.g3,
      };

      let meses = Array.isArray(parsed.meses) ? parsed.meses : [];
      let mesAtual = parsed.mesAtual || null;
      let lancamentos = Array.isArray(parsed.lancamentos) ? parsed.lancamentos : [];
      let pessoas = Array.isArray(parsed.pessoas) ? parsed.pessoas : [];

      if (!meses.length && lancamentos.length) {
        const ids = [...new Set(lancamentos.map((l) => l.mesId || (l.data || "").slice(0, 7)).filter(Boolean))];
        meses = ids.sort().reverse().map((id) => ({
          id,
          label: labelMes(id),
          status: "fechado",
          abertoEm: null,
          fechadoEm: new Date().toISOString(),
        }));
        lancamentos = lancamentos.map((l) => ({
          ...l,
          mesId: l.mesId || (l.data || "").slice(0, 7),
        }));
        mesAtual = null;
      }

      lancamentos = lancamentos.map((l) => migrarVaquinha(l));
      if (mesAtual && !meses.some((m) => m.id === mesAtual)) mesAtual = null;

      return {
        lancamentos,
        pesos,
        meses,
        mesAtual,
        pessoas,
        pendencias: Array.isArray(parsed.pendencias) ? parsed.pendencias : [],
        notificacoes: Array.isArray(parsed.notificacoes) ? parsed.notificacoes : [],
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    } catch {
      return defaultState();
    }
  }

  function defaultState() {
    return {
      lancamentos: [],
      pesos: { ...DEFAULT_PESOS },
      meses: [],
      mesAtual: null,
      pessoas: [],
      pendencias: [],
      notificacoes: [],
      updatedAt: 0,
    };
  }

  function saveState() {
    state.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (!applyingRemote) schedulePush();
  }

  function firebasePronto() {
    const cfg = window.FIREBASE_CONFIG;
    if (!cfg || !window.firebase) return false;
    const placeholder = !cfg.apiKey || String(cfg.apiKey).includes("COLE_AQUI");
    return !placeholder && Boolean(cfg.databaseURL);
  }

  function normalizarCodigoCasa(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
  }

  function setSyncStatus(status, detalhe) {
    syncStatus = status;
    const pill = $("#sync-status");
    const cfgStatus = $("#config-sync-status");
    const loginStatus = $("#sync-login-status");
    const labels = {
      offline: "Offline",
      local: "Só local",
      syncing: "Sincronizando…",
      online: "Online",
      error: "Erro sync",
    };
    const text = labels[status] || status;
    if (pill) {
      pill.textContent = text;
      pill.className = `sync-pill sync-pill--${status}`;
      pill.title = detalhe || text;
    }
    if (cfgStatus) cfgStatus.textContent = detalhe ? `${text} — ${detalhe}` : text;
    if (loginStatus) {
      if (!firebasePronto()) {
        loginStatus.textContent = "Firebase não configurado: dados ficam só neste aparelho.";
      } else if (navigator.onLine) {
        loginStatus.textContent = "Conectado — os dados serão sincronizados na nuvem.";
      } else {
        loginStatus.textContent = "Sem internet agora — sincroniza quando conectar.";
      }
    }
    const casaEl = $("#config-casa");
    if (casaEl) casaEl.textContent = codigoCasa || "—";
  }

  function payloadFromState() {
    return {
      updatedAt: state.updatedAt || Date.now(),
      lancamentos: state.lancamentos,
      pesos: state.pesos,
      meses: state.meses,
      mesAtual: state.mesAtual,
      pessoas: state.pessoas,
      pendencias: state.pendencias,
      notificacoes: state.notificacoes,
    };
  }

  function applyRemotePayload(payload) {
    if (!payload || typeof payload !== "object") return;
    const remoteAt = Number(payload.updatedAt) || 0;
    if (remoteAt && remoteAt <= (state.updatedAt || 0) && remoteAt <= lastRemoteUpdatedAt) {
      return;
    }

    applyingRemote = true;
    state = {
      lancamentos: Array.isArray(payload.lancamentos) ? payload.lancamentos : [],
      pesos: {
        g1: Number(payload.pesos?.g1) || DEFAULT_PESOS.g1,
        g2: Number(payload.pesos?.g2) || DEFAULT_PESOS.g2,
        g3: Number(payload.pesos?.g3) || DEFAULT_PESOS.g3,
      },
      meses: Array.isArray(payload.meses) ? payload.meses : [],
      mesAtual: payload.mesAtual || null,
      pessoas: Array.isArray(payload.pessoas) ? payload.pessoas : [],
      pendencias: Array.isArray(payload.pendencias) ? payload.pendencias : [],
      notificacoes: Array.isArray(payload.notificacoes) ? payload.notificacoes : [],
      updatedAt: remoteAt || Date.now(),
    };
    state.lancamentos = state.lancamentos.map((l) => migrarVaquinha(l));
    lastRemoteUpdatedAt = state.updatedAt;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    if (!mesSelecionado || !state.meses.some((m) => m.id === mesSelecionado)) {
      mesSelecionado = state.mesAtual || state.meses[0]?.id || null;
    }

    // Atualiza UI se já estiver logado
    if (usuarioAtual() && !$("#app").classList.contains("hidden")) {
      updateNotifBadge();
      updateMesStatus();
      fillFiltroMes();
      renderRelatorio();
      renderVaquinhaUI();
      renderPendencias();
      fillPendenciaPessoas();
      renderLoginUI();
      fillConfigForm();
    } else {
      renderLoginUI();
    }
    applyingRemote = false;
  }

  function schedulePush() {
    if (!firebasePronto() || !codigoCasa || !navigator.onLine) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushToCloud(), 400);
  }

  function pushToCloud() {
    if (!syncRef || applyingRemote || !navigator.onLine) return;
    setSyncStatus("syncing", "Enviando alterações…");
    const payload = payloadFromState();
    return syncRef
      .set(payload)
      .then(() => {
        lastRemoteUpdatedAt = payload.updatedAt;
        setSyncStatus("online", "Dados sincronizados");
      })
      .catch((err) => {
        console.error(err);
        setSyncStatus("error", err.message || "Falha ao enviar");
      });
  }

  function stopSync() {
    if (typeof syncUnsub === "function") {
      syncUnsub();
      syncUnsub = null;
    }
    syncRef = null;
  }

  function startSync(codigo) {
    stopSync();
    codigoCasa = normalizarCodigoCasa(codigo);
    if (!codigoCasa) {
      setSyncStatus("local", "Informe o código da casa");
      return Promise.resolve();
    }
    localStorage.setItem(CASA_KEY, codigoCasa);

    if (!firebasePronto()) {
      setSyncStatus("local", "Configure js/firebase-config.js");
      return Promise.resolve();
    }

    if (!navigator.onLine) {
      setSyncStatus("offline", "Sem internet — usando cópia local");
      return Promise.resolve();
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(window.FIREBASE_CONFIG);
      }
      syncRef = firebase.database().ref(`casas/${codigoCasa}/state`);
      setSyncStatus("syncing", "Conectando…");

      return syncRef
        .once("value")
        .then((snap) => {
          const remote = snap.val();
          if (remote && remote.updatedAt) {
            if (!state.updatedAt || remote.updatedAt >= state.updatedAt) {
              applyRemotePayload(remote);
            } else {
              return pushToCloud();
            }
          } else if ((state.lancamentos || []).length || (state.pessoas || []).length) {
            return pushToCloud();
          } else {
            return pushToCloud();
          }
        })
        .then(() => {
          const handler = (snap) => {
            const remote = snap.val();
            if (!remote) return;
            if (Number(remote.updatedAt) === Number(state.updatedAt)) return;
            if (Number(remote.updatedAt) <= Number(lastRemoteUpdatedAt)) return;
            applyRemotePayload(remote);
            setSyncStatus("online", "Atualizado da nuvem");
          };
          syncRef.on("value", handler);
          syncUnsub = () => syncRef.off("value", handler);
          setSyncStatus("online", "Sincronizado em tempo real");
        })
        .catch((err) => {
          console.error(err);
          setSyncStatus("error", err.message || "Falha na conexão");
        });
    } catch (err) {
      console.error(err);
      setSyncStatus("error", err.message || "Firebase inválido");
      return Promise.resolve();
    }
  }

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function todayISO() {
    const d = new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function currentMonthId() {
    return todayISO().slice(0, 7);
  }

  function labelMes(id) {
    if (!id || !/^\d{4}-\d{2}$/.test(id)) return "—";
    const [y, m] = id.split("-");
    return `${MESES_NOME[Number(m) - 1]}/${y}`;
  }

  function formatMoney(value) {
    return (Number(value) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }

  function formatDateTime(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("pt-BR", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function somaPesos(pesos = state.pesos) {
    return Number((pesos.g1 + pesos.g2 + pesos.g3).toFixed(4));
  }

  function dividirValor(valor, criterio, pesos = state.pesos) {
    const total = Number(valor) || 0;
    if (criterio === "igual_3") {
      const parte = total / 3;
      return { g1: parte, g2: parte, g3: parte };
    }
    const soma = somaPesos(pesos);
    if (soma <= 0) return { g1: 0, g2: 0, g3: 0 };
    return {
      g1: total * (pesos.g1 / soma),
      g2: total * (pesos.g2 / soma),
      g3: total * (pesos.g3 / soma),
    };
  }

  function getMes(id) {
    return state.meses.find((m) => m.id === id) || null;
  }

  function mesAberto() {
    return state.mesAtual ? getMes(state.mesAtual) : null;
  }

  function mesEstaAberto(id) {
    return Boolean(id && state.mesAtual === id);
  }

  function usuarioAtual() {
    return state.pessoas.find((p) => p.id === usuarioAtualId) || null;
  }

  function isAdmin() {
    const u = usuarioAtual();
    if (!u?.nome) return false;
    return u.nome.trim().toLowerCase() === ADMIN_NOME;
  }

  function autorMeta() {
    const u = usuarioAtual();
    return {
      lancadoPorId: u?.id || null,
      lancadoPorNome: u?.nome || "—",
    };
  }

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2800);
  }

  /* ---------- Notificações ---------- */
  function notificar({ paraUserIds, titulo, texto, tipo = "info", refId = null }) {
    const ids = [...new Set((paraUserIds || []).filter(Boolean))];
    const agora = new Date().toISOString();
    ids.forEach((paraUserId) => {
      state.notificacoes.unshift({
        id: uid(),
        paraUserId,
        titulo,
        texto,
        tipo,
        refId,
        lida: false,
        criadoEm: agora,
      });
    });
    if (state.notificacoes.length > 300) {
      state.notificacoes = state.notificacoes.slice(0, 300);
    }
  }

  function notificarTodosExceto(excetoId, payload) {
    const ids = state.pessoas.map((p) => p.id).filter((id) => id !== excetoId);
    notificar({ ...payload, paraUserIds: ids });
  }

  function notifsDoUsuario() {
    if (!usuarioAtualId) return [];
    return state.notificacoes.filter((n) => n.paraUserId === usuarioAtualId);
  }

  function updateNotifBadge() {
    const n = notifsDoUsuario().filter((x) => !x.lida).length;
    const badge = $("#badge-notif");
    if (n > 0) {
      badge.textContent = n > 99 ? "99+" : String(n);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  function renderNotificacoes() {
    const lista = $("#lista-notif");
    const empty = $("#empty-notif");
    const items = notifsDoUsuario();
    updateNotifBadge();

    if (!items.length) {
      lista.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    lista.innerHTML = items
      .map(
        (n) => `
      <article class="notif-item ${n.lida ? "" : "is-unread"}" data-id="${n.id}">
        <div class="notif-item__top">
          <strong>${escapeHtml(n.titulo)}</strong>
          <span class="detalhe">${formatDateTime(n.criadoEm)}</span>
        </div>
        <p class="notif-item__texto">${escapeHtml(n.texto)}</p>
      </article>`
      )
      .join("");
  }

  /* ---------- Login ---------- */
  function ensurePessoaByNome(nomeRaw) {
    const nome = nomeRaw.trim().replace(/\s+/g, " ");
    if (!nome) return null;
    let pessoa = state.pessoas.find((p) => p.nome.toLowerCase() === nome.toLowerCase());
    if (!pessoa) {
      pessoa = { id: uid(), nome };
      state.pessoas.push(pessoa);
      state.pessoas.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
      saveState();
    }
    return pessoa;
  }

  function entrarComo(pessoa) {
    usuarioAtualId = pessoa.id;
    localStorage.setItem(SESSION_KEY, pessoa.id);
    $("#tela-login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#nome-usuario").textContent = pessoa.nome;
    updateMesStatus();
    updateNotifBadge();
    fillFiltroMes();
    renderRelatorio();
    renderVaquinhaUI();
    renderPendencias();
    fillPendenciaPessoas();
    fillConfigForm();
    setSyncStatus(syncStatus);
    toast(`Bem-vindo(a), ${pessoa.nome}${isAdmin() ? " (admin)" : ""}!`);
  }

  function sair() {
    stopSync();
    usuarioAtualId = null;
    localStorage.removeItem(SESSION_KEY);
    $("#app").classList.add("hidden");
    $("#tela-login").classList.remove("hidden");
    renderLoginUI();
    $("#login-nome").value = "";
    if (codigoCasa) $("#login-casa").value = CASA_PADRAO;
    setSyncStatus(firebasePronto() ? (navigator.onLine ? "offline" : "offline") : "local");
    $("#login-nome").focus();
  }

  function renderLoginUI() {
    const datalist = $("#lista-usuarios-login");
    const rapidos = $("#usuarios-rapidos");
    if ($("#login-casa")) $("#login-casa").value = CASA_PADRAO;
    setSyncStatus(firebasePronto() ? (navigator.onLine ? "online" : "offline") : "local");

    datalist.innerHTML = state.pessoas
      .map((p) => `<option value="${escapeHtml(p.nome)}"></option>`)
      .join("");

    if (!state.pessoas.length) {
      rapidos.innerHTML = "";
      return;
    }
    rapidos.innerHTML =
      `<p class="login__rapidos-label">Entrar como</p>` +
      state.pessoas
        .map(
          (p) =>
            `<button type="button" class="btn btn--ghost btn--sm btn-user-rapido" data-id="${p.id}">${escapeHtml(p.nome)}</button>`
        )
        .join("");

    rapidos.querySelectorAll(".btn-user-rapido").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const casa = CASA_PADRAO;
        const p = state.pessoas.find((x) => x.id === btn.dataset.id);
        if (!p) return;
        await startSync(casa);
        entrarComo(p);
      });
    });
  }

  function initLogin() {
    $("#form-login").addEventListener("submit", async (e) => {
      e.preventDefault();
      const casa = CASA_PADRAO;
      await startSync(casa);
      const pessoa = ensurePessoaByNome($("#login-nome").value);
      if (!pessoa) return toast("Informe um nome.");
      saveState();
      schedulePush();
      entrarComo(pessoa);
    });
    $("#btn-sair").addEventListener("click", sair);
  }

  /* ---------- Tabs ---------- */
  function initTabs() {
    $$(".nav__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        $$(".nav__btn").forEach((b) => {
          const active = b.dataset.tab === tab;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-selected", String(active));
        });
        $$(".panel").forEach((panel) => {
          const match = panel.id === `tab-${tab}`;
          panel.classList.toggle("is-active", match);
          panel.hidden = !match;
        });
        if (tab === "relatorio") renderRelatorio();
        if (tab === "config") fillConfigForm();
        if (tab === "vaquinha") renderVaquinhaUI();
        if (tab === "pendencias") {
          fillPendenciaPessoas();
          renderPendencias();
        }
      });
    });
  }

  function updateMesStatus() {
    const box = $("#mes-status");
    if (!box) return;
    const aberto = mesAberto();
    box.classList.remove("mes-status--aberto", "mes-status--fechado", "mes-status--nenhum");

    if (aberto) {
      box.classList.add("mes-status--aberto");
      box.innerHTML = `
        <div class="mes-status__info">
          <span class="mes-status__label">Mês aberto</span>
          <span class="mes-status__valor">${aberto.label}</span>
        </div>
        <span class="badge badge--aberto">Aberto</span>`;
    } else if (state.meses.length) {
      box.classList.add("mes-status--fechado");
      box.innerHTML = `
        <div class="mes-status__info">
          <span class="mes-status__label">Situação</span>
          <span class="mes-status__valor">Nenhum mês aberto</span>
        </div>
        <span class="badge badge--fechado">Fechado</span>`;
    } else {
      box.classList.add("mes-status--nenhum");
      box.innerHTML = `
        <div class="mes-status__info">
          <span class="mes-status__label">Situação</span>
          <span class="mes-status__valor">Abra um mês para começar</span>
        </div>
        <span class="badge badge--nenhum">Sem mês</span>`;
    }

    const podeLancar = Boolean(aberto);
    ["#form-mercado", "#form-despesa", "#form-vaquinha"].forEach((sel) => {
      const form = $(sel);
      if (!form) return;
      form.classList.toggle("is-disabled", !podeLancar);
      $$(`${sel} input, ${sel} select, ${sel} button`).forEach((el) => {
        if (el.classList.contains("sel-peso")) {
          const chk = $(`.chk-participante[data-id="${el.dataset.id}"]`);
          el.disabled = !podeLancar || !chk?.checked;
        } else {
          el.disabled = !podeLancar;
        }
      });
    });
    $("#aviso-mercado")?.classList.toggle("hidden", podeLancar);
    $("#aviso-despesa")?.classList.toggle("hidden", podeLancar);
    $("#aviso-vaquinha")?.classList.toggle("hidden", podeLancar);

    const btnFechar = $("#btn-fechar-mes");
    const btnAbrir = $("#btn-abrir-mes");
    const admin = isAdmin();
    if (btnFechar) btnFechar.disabled = !aberto || !admin;
    if (btnAbrir) btnAbrir.disabled = !admin;
    const hintMes = $("#hint-mes-admin");
    if (hintMes) {
      hintMes.textContent = admin
        ? "Você é admin: pode abrir e fechar o mês."
        : "Somente Paulo (admin) pode abrir e fechar o mês.";
    }

    $$("#form-pessoa input, #form-pessoa button").forEach((el) => {
      el.disabled = false;
    });
    $("#form-pessoa")?.classList.remove("is-disabled");
  }

  function fillFiltroMes() {
    const select = $("#filtro-mes");
    if (!select) return;
    const prev = mesSelecionado;
    const ordenados = [...state.meses].sort((a, b) => b.id.localeCompare(a.id));

    if (!ordenados.length) {
      select.innerHTML = `<option value="">Nenhum mês</option>`;
      mesSelecionado = null;
      return;
    }

    select.innerHTML = ordenados
      .map((m) => {
        const tag = m.status === "aberto" ? " (aberto)" : " (fechado)";
        return `<option value="${m.id}">${m.label}${tag}</option>`;
      })
      .join("");

    if (prev && ordenados.some((m) => m.id === prev)) mesSelecionado = prev;
    else if (state.mesAtual) mesSelecionado = state.mesAtual;
    else mesSelecionado = ordenados[0].id;
    select.value = mesSelecionado;
  }

  /* ---------- Forms principais ---------- */
  function initForms() {
    $("#mercado-data").value = todayISO();
    $("#despesa-data").value = todayISO();
    $("#vaquinha-data").value = todayISO();
    $("#pendencia-data").value = todayISO();

    $("#form-mercado").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!mesAberto()) return toast("Abra um mês antes de lançar.");
      const data = $("#mercado-data").value;
      const comprador = $("#mercado-comprador").value;
      const pagamento = $("#mercado-pagamento").value;
      const valor = Number($("#mercado-valor").value);
      if (!data || !comprador || !pagamento || !(valor > 0)) return toast("Preencha todos os campos.");
      if (data.slice(0, 7) !== state.mesAtual) return toast(`A data deve pertencer a ${labelMes(state.mesAtual)}.`);

      const autor = autorMeta();
      const item = {
        id: uid(),
        mesId: state.mesAtual,
        tipo: "mercado",
        data,
        comprador,
        pagamento,
        valor,
        criterio: "proporcional",
        divisao: dividirValor(valor, "proporcional"),
        ...autor,
        criadoEm: new Date().toISOString(),
      };
      state.lancamentos.push(item);
      notificarTodosExceto(autor.lancadoPorId, {
        titulo: "Novo mercado",
        texto: `${autor.lancadoPorNome} lançou mercado de ${formatMoney(valor)} (${formatDate(data)}).`,
        tipo: "mercado",
        refId: item.id,
      });
      saveState();
      updateNotifBadge();
      e.target.reset();
      $("#mercado-data").value = todayISO();
      toast("Mercado lançado.");
    });

    $("#despesa-descricao").addEventListener("input", () => {
      if ($("#despesa-descricao").value.trim().toLowerCase() === "internet") {
        $("#despesa-criterio").value = "igual_3";
      }
    });

    $("#form-despesa").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!mesAberto()) return toast("Abra um mês antes de lançar.");
      const descricao = $("#despesa-descricao").value.trim();
      const data = $("#despesa-data").value;
      const criterio = $("#despesa-criterio").value;
      const valor = Number($("#despesa-valor").value);
      if (!descricao || !data || !criterio || !(valor > 0)) return toast("Preencha todos os campos.");
      if (data.slice(0, 7) !== state.mesAtual) return toast(`A data deve pertencer a ${labelMes(state.mesAtual)}.`);

      const autor = autorMeta();
      const item = {
        id: uid(),
        mesId: state.mesAtual,
        tipo: "despesa",
        descricao,
        data,
        criterio,
        valor,
        divisao: dividirValor(valor, criterio),
        ...autor,
        criadoEm: new Date().toISOString(),
      };
      state.lancamentos.push(item);
      notificarTodosExceto(autor.lancadoPorId, {
        titulo: "Nova despesa",
        texto: `${autor.lancadoPorNome} lançou "${descricao}" de ${formatMoney(valor)}.`,
        tipo: "despesa",
        refId: item.id,
      });
      saveState();
      updateNotifBadge();
      e.target.reset();
      $("#despesa-data").value = todayISO();
      toast("Despesa lançada.");
    });

    $("#form-pessoa").addEventListener("submit", (e) => {
      e.preventDefault();
      const nome = $("#pessoa-nome").value.trim();
      if (!nome) return toast("Informe o nome.");
      if (state.pessoas.some((p) => p.nome.toLowerCase() === nome.toLowerCase())) {
        return toast("Essa pessoa já está cadastrada.");
      }
      state.pessoas.push({ id: uid(), nome });
      state.pessoas.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
      saveState();
      e.target.reset();
      renderVaquinhaUI();
      fillPendenciaPessoas();
      renderLoginUI();
      toast(`${nome} cadastrado(a).`);
    });

    $("#form-vaquinha").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!mesAberto()) return toast("Abra um mês antes de lançar.");
      const descricao = $("#vaquinha-descricao").value.trim();
      const data = $("#vaquinha-data").value;
      const compras = coletarCompras();
      const participantesBase = coletarParticipantes();
      if (!descricao || !data) return toast("Preencha descrição e data.");
      if (data.slice(0, 7) !== state.mesAtual) return toast(`A data deve pertencer a ${labelMes(state.mesAtual)}.`);
      if (!compras.length) return toast("Adicione ao menos uma compra.");
      if (participantesBase.length < 2) return toast("Selecione ao menos 2 participantes.");
      const partIds = new Set(participantesBase.map((p) => p.pessoaId));
      if (compras.some((c) => !partIds.has(c.pessoaId))) {
        return toast("Quem pagou precisa estar nos participantes.");
      }
      const total = compras.reduce((acc, c) => acc + c.valor, 0);
      if (!(total > 0)) return toast("Total inválido.");

      const autor = autorMeta();
      const item = {
        id: uid(),
        mesId: state.mesAtual,
        tipo: "vaquinha",
        descricao,
        data,
        compras,
        valor: total,
        participantes: calcularAcerto(compras, participantesBase),
        ...autor,
        criadoEm: new Date().toISOString(),
      };
      state.lancamentos.push(item);
      const autorId = autor.lancadoPorId;
      participantesBase.forEach((p) => {
        if (p.pessoaId === autorId) return;
        const acerto = item.participantes.find((x) => x.pessoaId === p.pessoaId);
        if (!acerto) return;
        const s = textoSaldo(acerto.saldo);
        notificar({
          paraUserIds: [p.pessoaId],
          titulo: `Vaquinha: ${descricao}`,
          texto: `${autor.lancadoPorNome} criou vaquinha de ${formatMoney(total)}. Seu acerto: ${s.texto}.`,
          tipo: "vaquinha",
          refId: item.id,
        });
      });
      // Avisa quem não participa mas está no sistema
      const partSet = new Set(participantesBase.map((p) => p.pessoaId));
      const outros = state.pessoas
        .map((p) => p.id)
        .filter((id) => id !== autorId && !partSet.has(id));
      if (outros.length) {
        notificar({
          paraUserIds: outros,
          titulo: "Nova vaquinha",
          texto: `${autor.lancadoPorNome} criou vaquinha "${descricao}" de ${formatMoney(total)}.`,
          tipo: "vaquinha",
          refId: item.id,
        });
      }
      saveState();
      updateNotifBadge();
      e.target.reset();
      $("#vaquinha-data").value = todayISO();
      $("#vaquinha-compras").innerHTML = "";
      renderVaquinhaUI();
      toast("Vaquinha salva.");
    });

    $("#btn-add-compra").addEventListener("click", () => {
      if (!state.pessoas.length) return toast("Cadastre pessoas antes.");
      adicionarLinhaCompra();
      atualizarPreviewVaquinha();
      updateMesStatus();
    });

    $("#form-pesos").addEventListener("submit", (e) => {
      e.preventDefault();
      const g1 = Number($("#peso-g1").value);
      const g2 = Number($("#peso-g2").value);
      const g3 = Number($("#peso-g3").value);
      if (!(g1 > 0) || !(g2 > 0) || !(g3 > 0)) return toast("Pesos devem ser > 0.");
      state.pesos = { g1, g2, g3 };
      state.lancamentos = state.lancamentos.map((item) => {
        if (item.tipo === "vaquinha") return item;
        if (item.criterio === "igual_3") return { ...item, divisao: dividirValor(item.valor, "igual_3") };
        return { ...item, divisao: dividirValor(item.valor, "proporcional") };
      });
      const autor = autorMeta();
      notificarTodosExceto(autor.lancadoPorId, {
        titulo: "Pesos atualizados",
        texto: `${autor.lancadoPorNome} alterou os pesos dos grupos.`,
        tipo: "config",
      });
      saveState();
      updateNotifBadge();
      updateSomaPesos();
      toast("Pesos atualizados.");
    });

    ["peso-g1", "peso-g2", "peso-g3"].forEach((id) => {
      $(`#${id}`).addEventListener("input", updateSomaPesos);
    });

    $("#filtro-mes").addEventListener("change", (e) => {
      mesSelecionado = e.target.value || null;
      renderRelatorio();
    });

    $("#btn-abrir-mes").addEventListener("click", () => {
      if (!isAdmin()) return toast("Somente Paulo pode abrir o mês.");
      $("#erro-abrir-mes").classList.add("hidden");
      $("#input-abrir-mes").value = currentMonthId();
      $("#modal-abrir-mes").showModal();
    });

    $("#btn-cancelar-abrir").addEventListener("click", () => $("#modal-abrir-mes").close());

    $("#form-abrir-mes").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!isAdmin()) return toast("Somente Paulo pode abrir o mês.");
      const id = $("#input-abrir-mes").value;
      const erro = $("#erro-abrir-mes");
      if (!id) {
        erro.textContent = "Selecione o mês.";
        erro.classList.remove("hidden");
        return;
      }
      if (state.mesAtual) {
        erro.textContent = `Feche ${labelMes(state.mesAtual)} antes.`;
        erro.classList.remove("hidden");
        return;
      }
      const existente = getMes(id);
      if (existente && existente.status === "fechado") {
        erro.textContent = "Este mês já foi fechado.";
        erro.classList.remove("hidden");
        return;
      }
      const autor = autorMeta();
      if (existente && existente.status === "aberto") {
        state.mesAtual = id;
      } else {
        state.meses.unshift({
          id,
          label: labelMes(id),
          status: "aberto",
          abertoEm: new Date().toISOString(),
          abertoPorNome: autor.lancadoPorNome,
          fechadoEm: null,
        });
        state.mesAtual = id;
      }
      mesSelecionado = id;
      notificarTodosExceto(autor.lancadoPorId, {
        titulo: "Mês aberto",
        texto: `${autor.lancadoPorNome} abriu ${labelMes(id)}.`,
        tipo: "mes",
      });
      saveState();
      updateNotifBadge();
      $("#modal-abrir-mes").close();
      updateMesStatus();
      fillFiltroMes();
      renderRelatorio();
      toast(`${labelMes(id)} aberto.`);
    });

    $("#btn-fechar-mes").addEventListener("click", () => {
      if (!isAdmin()) return toast("Somente Paulo pode fechar o mês.");
      const aberto = mesAberto();
      if (!aberto) return toast("Não há mês aberto.");
      if (!confirm(`Fechar ${aberto.label}?`)) return;
      const autor = autorMeta();
      aberto.status = "fechado";
      aberto.fechadoEm = new Date().toISOString();
      aberto.fechadoPorNome = autor.lancadoPorNome;
      state.mesAtual = null;
      notificarTodosExceto(autor.lancadoPorId, {
        titulo: "Mês fechado",
        texto: `${autor.lancadoPorNome} fechou ${aberto.label}.`,
        tipo: "mes",
      });
      saveState();
      updateNotifBadge();
      updateMesStatus();
      fillFiltroMes();
      renderRelatorio();
      toast(`${aberto.label} fechado.`);
    });

    $("#btn-limpar").addEventListener("click", () => {
      if (!mesSelecionado) return toast("Selecione um mês.");
      if (!mesEstaAberto(mesSelecionado)) return toast("Só é possível limpar o mês aberto.");
      const label = labelMes(mesSelecionado);
      if (!confirm(`Apagar lançamentos de ${label}?`)) return;
      const autor = autorMeta();
      state.lancamentos = state.lancamentos.filter((l) => l.mesId !== mesSelecionado);
      notificarTodosExceto(autor.lancadoPorId, {
        titulo: "Mês limpo",
        texto: `${autor.lancadoPorNome} limpou os lançamentos de ${label}.`,
        tipo: "mes",
      });
      saveState();
      updateNotifBadge();
      renderRelatorio();
      toast(`Lançamentos de ${label} apagados.`);
    });

    initPendencias();
    initNotifUI();
  }

  /* ---------- Pendências ---------- */
  function fillPendenciaPessoas() {
    const select = $("#pendencia-pessoa");
    const outros = state.pessoas.filter((p) => p.id !== usuarioAtualId);
    select.innerHTML =
      `<option value="">Selecione…</option>` +
      outros.map((p) => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join("");
  }

  function initPendencias() {
    $("#pendencia-tipo").addEventListener("change", () => {
      const tipo = $("#pendencia-tipo").value;
      $("#pendencia-pessoa-label").textContent =
        tipo === "receber" ? "Quem me deve" : "Para quem eu devo";
    });

    $("#form-pendencia").addEventListener("submit", (e) => {
      e.preventDefault();
      const u = usuarioAtual();
      if (!u) return toast("Faça login.");
      const descricao = $("#pendencia-descricao").value.trim();
      const data = $("#pendencia-data").value;
      const tipo = $("#pendencia-tipo").value;
      const outraId = $("#pendencia-pessoa").value;
      const valor = Number($("#pendencia-valor").value);
      const outra = state.pessoas.find((p) => p.id === outraId);

      if (!descricao || !data || !outra || !(valor > 0)) {
        return toast("Preencha todos os campos.");
      }

      const receber = tipo === "receber";
      const pend = {
        id: uid(),
        descricao,
        data,
        valor,
        credorId: receber ? u.id : outra.id,
        credorNome: receber ? u.nome : outra.nome,
        devedorId: receber ? outra.id : u.id,
        devedorNome: receber ? outra.nome : u.nome,
        status: "pendente",
        criadoPorId: u.id,
        criadoPorNome: u.nome,
        criadoEm: new Date().toISOString(),
        pagoEm: null,
        pagoPorId: null,
      };

      state.pendencias.unshift(pend);

      const alvoId = receber ? outra.id : outra.id;
      notificar({
        paraUserIds: [alvoId],
        titulo: receber ? "Você tem um valor a pagar" : "Alguém registrou que te deve",
        texto: receber
          ? `${u.nome} lançou "${descricao}" — você deve ${formatMoney(valor)}.`
          : `${u.nome} registrou que deve ${formatMoney(valor)} a você ("${descricao}").`,
        tipo: "pendencia",
        refId: pend.id,
      });

      saveState();
      updateNotifBadge();
      e.target.reset();
      $("#pendencia-data").value = todayISO();
      fillPendenciaPessoas();
      renderPendencias();
      toast("Pendência salva.");
    });
  }

  function renderPendencias() {
    const box = $("#lista-pendencias");
    const empty = $("#empty-pendencias");
    const u = usuarioAtual();
    if (!u) return;

    const items = state.pendencias.filter(
      (p) => p.credorId === u.id || p.devedorId === u.id
    );

    $("#pendencias-count").textContent = `${items.length} ite${items.length === 1 ? "m" : "ns"}`;

    if (!items.length) {
      box.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    box.innerHTML = items
      .map((p) => {
        const souCredor = p.credorId === u.id;
        const tipoLabel = souCredor ? "A receber" : "A pagar";
        const outra = souCredor ? p.devedorNome : p.credorNome;
        const tipoClass = souCredor ? "pendencia--receber" : "pendencia--pagar";
        const statusBadge =
          p.status === "pago"
            ? `<span class="badge badge--aberto">Pago</span>`
            : `<span class="badge badge--fechado">Pendente</span>`;

        const acao =
          p.status === "pendente"
            ? `<button type="button" class="btn btn--primary btn--sm btn-pagar-pend" data-id="${p.id}">Marcar como pago</button>`
            : `<span class="detalhe">Pago em ${formatDateTime(p.pagoEm)}</span>`;

        return `
          <article class="pendencia ${tipoClass}">
            <div class="pendencia__head">
              <div>
                <p class="pendencia__tipo">${tipoLabel} · ${escapeHtml(outra)}</p>
                <h4 class="pendencia__titulo">${escapeHtml(p.descricao)}</h4>
              </div>
              ${statusBadge}
            </div>
            <p class="pendencia__valor">${formatMoney(p.valor)}</p>
            <p class="detalhe">${formatDate(p.data)} · por ${escapeHtml(p.criadoPorNome)}</p>
            <div class="pendencia__acoes">${acao}</div>
          </article>`;
      })
      .join("");

    box.querySelectorAll(".btn-pagar-pend").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pend = state.pendencias.find((p) => p.id === btn.dataset.id);
        if (!pend || pend.status === "pago") return;
        if (!confirm("Confirmar pagamento desta pendência?")) return;
        const autor = autorMeta();
        pend.status = "pago";
        pend.pagoEm = new Date().toISOString();
        pend.pagoPorId = autor.lancadoPorId;
        pend.pagoPorNome = autor.lancadoPorNome;

        const outroId = pend.credorId === usuarioAtualId ? pend.devedorId : pend.credorId;
        notificar({
          paraUserIds: [outroId],
          titulo: "Pendência paga",
          texto: `${autor.lancadoPorNome} marcou "${pend.descricao}" (${formatMoney(pend.valor)}) como pago.`,
          tipo: "pendencia",
          refId: pend.id,
        });
        saveState();
        updateNotifBadge();
        renderPendencias();
        toast("Marcado como pago.");
      });
    });
  }

  function initNotifUI() {
    $("#btn-notificacoes").addEventListener("click", () => {
      renderNotificacoes();
      $("#modal-notif").showModal();
    });
    $("#btn-fechar-notif").addEventListener("click", () => $("#modal-notif").close());
    $("#btn-marcar-lidas").addEventListener("click", () => {
      state.notificacoes.forEach((n) => {
        if (n.paraUserId === usuarioAtualId) n.lida = true;
      });
      saveState();
      renderNotificacoes();
      toast("Notificações marcadas como lidas.");
    });
  }

  /* ---------- Vaquinha ---------- */
  function opcoesPessoasHtml(selectedId = "") {
    return (
      `<option value="">Quem pagou…</option>` +
      state.pessoas
        .map(
          (p) =>
            `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${escapeHtml(p.nome)}</option>`
        )
        .join("")
    );
  }

  function adicionarLinhaCompra(pessoaId = "", valor = "") {
    const box = $("#vaquinha-compras");
    const row = document.createElement("div");
    row.className = "compra-row";
    row.innerHTML = `
      <select class="compra-pessoa" required>${opcoesPessoasHtml(pessoaId)}</select>
      <input type="number" class="compra-valor" min="0.01" step="0.01" placeholder="0,00" value="${valor}" required />
      <button type="button" class="btn btn--icon btn-remover-compra" title="Remover" aria-label="Remover">×</button>
    `;
    box.appendChild(row);
    row.querySelector(".compra-pessoa").addEventListener("change", atualizarPreviewVaquinha);
    row.querySelector(".compra-valor").addEventListener("input", atualizarPreviewVaquinha);
    row.querySelector(".btn-remover-compra").addEventListener("click", () => {
      if ($$("#vaquinha-compras .compra-row").length <= 1) {
        return toast("Mantenha ao menos uma compra.");
      }
      row.remove();
      atualizarPreviewVaquinha();
    });
  }

  function atualizarOpcoesCompras() {
    $$("#vaquinha-compras .compra-pessoa").forEach((sel) => {
      const atual = sel.value;
      sel.innerHTML = opcoesPessoasHtml(atual);
    });
  }

  function coletarCompras() {
    const compras = [];
    $$("#vaquinha-compras .compra-row").forEach((row) => {
      const pessoaId = row.querySelector(".compra-pessoa").value;
      const valor = Number(row.querySelector(".compra-valor").value);
      const pessoa = state.pessoas.find((p) => p.id === pessoaId);
      if (pessoa && valor > 0) {
        compras.push({ id: uid(), pessoaId, nome: pessoa.nome, valor });
      }
    });
    return compras;
  }

  function calcularAcerto(compras, participantesBase) {
    const total = compras.reduce((acc, c) => acc + c.valor, 0);
    const somaPesosPart = participantesBase.reduce((acc, p) => acc + p.peso, 0);
    const pagoPorPessoa = {};
    compras.forEach((c) => {
      pagoPorPessoa[c.pessoaId] = (pagoPorPessoa[c.pessoaId] || 0) + c.valor;
    });
    return participantesBase.map((p) => {
      const cota = somaPesosPart > 0 ? total * (p.peso / somaPesosPart) : 0;
      const pagou = pagoPorPessoa[p.pessoaId] || 0;
      return {
        pessoaId: p.pessoaId,
        nome: p.nome,
        peso: p.peso,
        cota,
        pagou,
        saldo: pagou - cota,
        valor: cota,
      };
    });
  }

  function migrarVaquinha(item) {
    if (!item || item.tipo !== "vaquinha") return item;
    let compras = Array.isArray(item.compras) ? item.compras : [];
    if (!compras.length && item.quemPagouId) {
      compras = [{
        id: item.id + "-c1",
        pessoaId: item.quemPagouId,
        nome: item.quemPagouNome || "—",
        valor: Number(item.valor) || 0,
      }];
    }
    const base = (item.participantes || []).map((p) => ({
      pessoaId: p.pessoaId,
      nome: p.nome,
      peso: Number(p.peso) || 1,
    }));
    if (!compras.length || !base.length) {
      return { ...item, compras, participantes: item.participantes || [] };
    }
    const participantes = calcularAcerto(compras, base);
    const valor = compras.reduce((acc, c) => acc + (Number(c.valor) || 0), 0);
    return { ...item, compras, valor, participantes };
  }

  function textoSaldo(saldo) {
    const v = Math.abs(saldo);
    if (Math.abs(saldo) < 0.005) return { classe: "saldo--ok", texto: "Quitado" };
    if (saldo > 0) return { classe: "saldo--receber", texto: `A receber ${formatMoney(v)}` };
    return { classe: "saldo--pagar", texto: `A pagar ${formatMoney(v)}` };
  }

  function renderVaquinhaUI() {
    const lista = $("#lista-pessoas");
    const empty = $("#empty-pessoas");
    const boxPart = $("#vaquinha-participantes");
    const emptyPart = $("#empty-participantes");
    const boxCompras = $("#vaquinha-compras");

    if (!state.pessoas.length) {
      lista.innerHTML = "";
      empty.classList.remove("hidden");
      boxPart.innerHTML = "";
      emptyPart.classList.remove("hidden");
      boxCompras.innerHTML = "";
      $("#soma-pesos-vaquinha").textContent = "0";
      $("#total-compras-vaquinha").textContent = formatMoney(0);
      $("#preview-divisao").innerHTML = "";
      updateMesStatus();
      return;
    }

    empty.classList.add("hidden");
    emptyPart.classList.add("hidden");

    lista.innerHTML = state.pessoas
      .map(
        (p) => `
      <li class="lista-pessoas__item">
        <span>${escapeHtml(p.nome)}${p.id === usuarioAtualId ? " (você)" : ""}</span>
        <button type="button" class="btn btn--icon btn-excluir-pessoa" data-id="${p.id}" title="Remover">×</button>
      </li>`
      )
      .join("");

    lista.querySelectorAll(".btn-excluir-pessoa").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (id === usuarioAtualId) return toast("Não é possível remover o usuário logado.");
        const pessoa = state.pessoas.find((p) => p.id === id);
        if (!confirm(`Remover ${pessoa?.nome}?`)) return;
        state.pessoas = state.pessoas.filter((p) => p.id !== id);
        saveState();
        renderVaquinhaUI();
        fillPendenciaPessoas();
        renderLoginUI();
        toast("Pessoa removida.");
      });
    });

    const marcados = {};
    $$("#vaquinha-participantes .chk-participante").forEach((chk) => {
      marcados[chk.dataset.id] = {
        checked: chk.checked,
        peso: $(`#vaquinha-participantes .sel-peso[data-id="${chk.dataset.id}"]`)?.value || "1",
      };
    });

    boxPart.innerHTML = state.pessoas
      .map((p) => {
        const prev = marcados[p.id];
        const checked = prev?.checked ? "checked" : "";
        const peso = prev?.peso || "1";
        const disabled = prev?.checked ? "" : "disabled";
        return `
      <div class="participante" data-id="${p.id}">
        <label class="participante__check">
          <input type="checkbox" class="chk-participante" data-id="${p.id}" ${checked} />
          <span>${escapeHtml(p.nome)}</span>
        </label>
        <span></span>
        <label class="participante__peso">
          Peso
          <select class="sel-peso" data-id="${p.id}" ${disabled}>
            ${[1, 2, 3, 4].map((n) => `<option value="${n}" ${String(n) === String(peso) ? "selected" : ""}>${n}</option>`).join("")}
          </select>
        </label>
      </div>`;
      })
      .join("");

    boxPart.querySelectorAll(".chk-participante").forEach((chk) => {
      chk.addEventListener("change", () => {
        const sel = boxPart.querySelector(`.sel-peso[data-id="${chk.dataset.id}"]`);
        sel.disabled = !chk.checked;
        if (!chk.checked) sel.value = "1";
        atualizarPreviewVaquinha();
        updateMesStatus();
      });
    });
    boxPart.querySelectorAll(".sel-peso").forEach((sel) => {
      sel.addEventListener("change", atualizarPreviewVaquinha);
    });

    if (!boxCompras.children.length) adicionarLinhaCompra();
    else atualizarOpcoesCompras();

    atualizarPreviewVaquinha();
    updateMesStatus();
  }

  function coletarParticipantes() {
    const selecionados = [];
    $$("#vaquinha-participantes .chk-participante:checked").forEach((chk) => {
      const id = chk.dataset.id;
      const pessoa = state.pessoas.find((p) => p.id === id);
      const peso = Number($(`#vaquinha-participantes .sel-peso[data-id="${id}"]`).value);
      if (pessoa && peso >= 1 && peso <= 4) {
        selecionados.push({ pessoaId: id, nome: pessoa.nome, peso });
      }
    });
    return selecionados;
  }

  function atualizarPreviewVaquinha() {
    const participantesBase = coletarParticipantes();
    const compras = coletarCompras();
    const total = compras.reduce((acc, c) => acc + c.valor, 0);
    const soma = participantesBase.reduce((acc, p) => acc + p.peso, 0);
    $("#soma-pesos-vaquinha").textContent = String(soma);
    $("#total-compras-vaquinha").textContent = formatMoney(total);
    const preview = $("#preview-divisao");
    if (participantesBase.length < 2 || !(total > 0) || soma <= 0) {
      preview.innerHTML = "";
      return;
    }
    const acerto = calcularAcerto(compras, participantesBase);
    preview.innerHTML =
      `<p class="peso-total" style="margin:0 0 0.35rem">Acerto final (pago − cota)</p>` +
      acerto
        .map((p) => {
          const s = textoSaldo(p.saldo);
          return `
          <div class="preview-divisao__item">
            <div class="preview-divisao__topo">
              <span>${escapeHtml(p.nome)} <span class="detalhe">(peso ${p.peso})</span></span>
              <span class="saldo ${s.classe}">${s.texto}</span>
            </div>
            <div class="preview-divisao__meta">Cota ${formatMoney(p.cota)} · Pagou ${formatMoney(p.pagou)}</div>
          </div>`;
        })
        .join("");
  }

  function fillConfigForm() {
    $("#peso-g1").value = state.pesos.g1;
    $("#peso-g2").value = state.pesos.g2;
    $("#peso-g3").value = state.pesos.g3;
    updateSomaPesos();
    setSyncStatus(syncStatus);
  }

  function updateSomaPesos() {
    const g1 = Number($("#peso-g1").value) || 0;
    const g2 = Number($("#peso-g2").value) || 0;
    const g3 = Number($("#peso-g3").value) || 0;
    $("#soma-pesos").textContent = (g1 + g2 + g3).toFixed(1);
  }

  /* ---------- Relatório ---------- */
  function renderRelatorio() {
    fillFiltroMes();
    updateMesStatus();

    const mes = mesSelecionado ? getMes(mesSelecionado) : null;
    const badge = $("#mes-badge");
    if (!mes) {
      badge.textContent = "Sem mês";
      badge.className = "badge badge--nenhum";
    } else if (mes.status === "aberto") {
      badge.textContent = "Aberto";
      badge.className = "badge badge--aberto";
    } else {
      badge.textContent = "Fechado";
      badge.className = "badge badge--fechado";
    }

    const items = state.lancamentos
      .filter((l) => l.mesId === mesSelecionado)
      .sort((a, b) => {
        if (a.data === b.data) return (b.criadoEm || "").localeCompare(a.criadoEm || "");
        return b.data.localeCompare(a.data);
      });

    const casa = items.filter((l) => l.tipo !== "vaquinha");
    const vaquinhas = items.filter((l) => l.tipo === "vaquinha");

    const totais = casa.reduce(
      (acc, item) => {
        acc.geral += item.valor;
        acc.g1 += item.divisao?.g1 || 0;
        acc.g2 += item.divisao?.g2 || 0;
        acc.g3 += item.divisao?.g3 || 0;
        return acc;
      },
      { geral: 0, g1: 0, g2: 0, g3: 0 }
    );

    const totalVaquinhas = vaquinhas.reduce((acc, item) => acc + item.valor, 0);
    const porPessoa = {};
    vaquinhas.forEach((v) => {
      (v.participantes || []).forEach((p) => {
        if (!porPessoa[p.pessoaId]) {
          porPessoa[p.pessoaId] = { nome: p.nome, saldo: 0, cota: 0, pagou: 0 };
        }
        porPessoa[p.pessoaId].saldo += p.saldo ?? (p.pagou || 0) - (p.cota ?? p.valor ?? 0);
        porPessoa[p.pessoaId].cota += p.cota ?? p.valor ?? 0;
        porPessoa[p.pessoaId].pagou += p.pagou || 0;
      });
    });
    const listaPessoasVaq = Object.values(porPessoa).sort((a, b) =>
      a.nome.localeCompare(b.nome, "pt-BR")
    );

    const soma = somaPesos();
    const tituloMes = mes ? mes.label : "Nenhum mês";
    $("#resumo-cards").innerHTML = `
      <div class="card-resumo card-resumo--total">
        <p class="card-resumo__label">Casa — ${escapeHtml(tituloMes)}</p>
        <p class="card-resumo__valor">${formatMoney(totais.geral)}</p>
        <p class="card-resumo__meta">${casa.length} lançamento(s) · pesos ${soma.toFixed(1)}</p>
      </div>
      <div class="grupos-grid">
        ${["g1", "g2", "g3"]
          .map(
            (g) => `
          <div class="card-grupo">
            <p class="card-grupo__nome">${GRUPOS[g]}</p>
            <p class="card-grupo__valor">${formatMoney(totais[g])}</p>
            <p class="card-grupo__peso">Peso ${state.pesos[g].toFixed(1)} · ${((state.pesos[g] / soma) * 100).toFixed(1)}%</p>
          </div>`
          )
          .join("")}
      </div>`;

    const resumoVaq = $("#resumo-vaquinhas");
    if (vaquinhas.length) {
      resumoVaq.innerHTML = `
        <div class="card-resumo">
          <p class="card-resumo__label">Vaquinhas — ${escapeHtml(tituloMes)}</p>
          <p class="card-resumo__valor" style="color:var(--brand)">${formatMoney(totalVaquinhas)}</p>
          <p class="card-resumo__meta">${vaquinhas.length} vaquinha(s)</p>
        </div>
        <div class="grupos-grid">
          ${listaPessoasVaq
            .map((p) => {
              const s = textoSaldo(p.saldo);
              return `
            <div class="card-grupo">
              <p class="card-grupo__nome">${escapeHtml(p.nome)}</p>
              <p class="card-grupo__valor ${s.classe}">${s.texto}</p>
              <p class="card-grupo__peso">Cota ${formatMoney(p.cota)} · Pagou ${formatMoney(p.pagou)}</p>
            </div>`;
            })
            .join("")}
        </div>`;
    } else {
      resumoVaq.innerHTML = "";
    }

    $("#lancamentos-count").textContent = `${items.length} ite${items.length === 1 ? "m" : "ns"}`;
    const tbody = $("#tbody-lancamentos");
    const empty = $("#empty-lancamentos");
    const podeExcluir = mesEstaAberto(mesSelecionado);

    if (!items.length) {
      tbody.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    tbody.innerHTML = items
      .map((item) => {
        let tipoBadge = `<span class="badge">Despesa</span>`;
        if (item.tipo === "mercado") tipoBadge = `<span class="badge badge--mercado">Mercado</span>`;
        if (item.tipo === "vaquinha") tipoBadge = `<span class="badge badge--vaquinha">Vaquinha</span>`;

        let detalhe = "";
        if (item.tipo === "mercado") {
          detalhe = `${COMPRADORES[item.comprador]?.label || item.comprador}<br><span class="detalhe">${PAGAMENTOS[item.pagamento] || item.pagamento}</span>`;
        } else if (item.tipo === "vaquinha") {
          const comprasTxt = (item.compras || []).map((c) => `${escapeHtml(c.nome)} ${formatMoney(c.valor)}`).join(" · ");
          const parts = (item.participantes || [])
            .map((p) => `${escapeHtml(p.nome)}: ${textoSaldo(p.saldo ?? 0).texto}`)
            .join("<br>");
          detalhe = `${escapeHtml(item.descricao)}<br><span class="detalhe">Compras: ${comprasTxt || "—"}</span><br>${parts}`;
        } else {
          const crit = item.criterio === "igual_3" ? "3 partes iguais" : "Proporcional";
          detalhe = `${escapeHtml(item.descricao)}<br><span class="detalhe">${crit}</span>`;
        }
        detalhe += `<br><span class="detalhe">Por ${escapeHtml(item.lancadoPorNome || "—")}</span>`;

        const acao = podeExcluir
          ? `<button type="button" class="btn btn--icon btn-excluir" data-id="${item.id}" title="Excluir">×</button>`
          : `<span class="detalhe">—</span>`;

        return `
          <tr data-id="${item.id}">
            <td>${formatDate(item.data)}</td>
            <td>${tipoBadge}</td>
            <td>${detalhe}</td>
            <td>${formatMoney(item.valor)}</td>
            <td>${acao}</td>
          </tr>`;
      })
      .join("");

    tbody.querySelectorAll(".btn-excluir").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const item = state.lancamentos.find((l) => l.id === id);
        if (!confirm("Excluir este lançamento?")) return;
        const autor = autorMeta();
        state.lancamentos = state.lancamentos.filter((l) => l.id !== id);
        notificarTodosExceto(autor.lancadoPorId, {
          titulo: "Lançamento excluído",
          texto: `${autor.lancadoPorNome} excluiu um lançamento (${item?.tipo || "item"}).`,
          tipo: "exclusao",
          refId: id,
        });
        saveState();
        updateNotifBadge();
        renderRelatorio();
        toast("Excluído.");
      });
    });
  }

  /* ---------- PWA ---------- */
  function initPWA() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").then((reg) => {
          reg.update();
          setInterval(() => reg.update(), 60 * 60 * 1000);
          reg.addEventListener("updatefound", () => {
            const worker = reg.installing;
            if (!worker) return;
            worker.addEventListener("statechange", () => {
              if (worker.state === "installed" && navigator.serviceWorker.controller) {
                toast("Nova versão disponível — recarregando…");
                worker.postMessage("SKIP_WAITING");
                setTimeout(() => location.reload(), 800);
              }
            });
          });
        }).catch(() => {});
      });

      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        location.reload();
      });
    }

    window.addEventListener("online", () => {
      setSyncStatus("syncing", "Reconectando…");
      if (codigoCasa) startSync(codigoCasa);
    });
    window.addEventListener("offline", () => {
      setSyncStatus("offline", "Sem internet — alterações ficam locais");
    });

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      $("#btn-install").classList.remove("hidden");
    });
    $("#btn-install").addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      $("#btn-install").classList.add("hidden");
    });
  }

  function init() {
    initLogin();
    initTabs();
    initForms();
    initPWA();
    fillConfigForm();
    renderLoginUI();

    $("#btn-sync-agora")?.addEventListener("click", async () => {
      if (!codigoCasa) return toast("Entre com um código da casa.");
      if (!firebasePronto()) return toast("Configure o Firebase em js/firebase-config.js");
      if (!navigator.onLine) return toast("Sem internet no momento.");
      await startSync(codigoCasa);
      await pushToCloud();
      toast("Sincronização concluída.");
    });

    const salvo = usuarioAtualId && state.pessoas.find((p) => p.id === usuarioAtualId);
    const boot = async () => {
      if (codigoCasa) await startSync(codigoCasa);
      if (salvo) {
        // revalida usuário após sync (pode ter vindo da nuvem)
        const atualizado = state.pessoas.find((p) => p.id === usuarioAtualId)
          || state.pessoas.find((p) => p.nome.toLowerCase() === salvo.nome.toLowerCase());
        if (atualizado) entrarComo(atualizado);
        else {
          usuarioAtualId = null;
          localStorage.removeItem(SESSION_KEY);
          $("#tela-login").classList.remove("hidden");
          $("#app").classList.add("hidden");
        }
      } else {
        usuarioAtualId = null;
        localStorage.removeItem(SESSION_KEY);
        $("#tela-login").classList.remove("hidden");
        $("#app").classList.add("hidden");
      }
    };
    boot();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
