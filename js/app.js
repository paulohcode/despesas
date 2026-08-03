(() => {
  "use strict";

  const STORAGE_KEY = "despesas_domesticas_v1";
  const SESSION_KEY = "despesas_usuario_atual";
  const CASA_KEY = "despesas_codigo_casa";
  const CASA_PADRAO = "familia-silva";
  const ADMIN_NOME = "paulo";
  const DEFAULT_GRUPOS = [
    { id: "g1", nome: "Paulo / esposa / filhos", peso: 3.0 },
    { id: "g2", nome: "Mãe / irmão / avô", peso: 3.0 },
    { id: "g3", nome: "Cunhada / irmão (fim de semana)", peso: 1.8 },
  ];
  const DEFAULT_TIPOS_DESPESA = [
    { id: "td-agua", nome: "Água" },
    { id: "td-luz", nome: "Luz" },
    { id: "td-gas", nome: "Gás" },
    { id: "td-internet", nome: "Internet" },
    { id: "td-condominio", nome: "Condomínio" },
  ];
  const DEFAULT_PESSOAL_TIPOS = ["Compra", "Serviço", "Assinatura", "Outro"];
  const DEFAULT_PESSOAL_CATEGORIAS = [
    "Alimentação",
    "Combustível",
    "Saúde",
    "Moradia",
    "Transporte",
    "Lazer",
    "Educação",
    "Vestuário",
    "Outros",
  ];
  const DEFAULT_PESSOAL_PAGAMENTOS = ["PIX", "Crédito", "Débito", "Dinheiro"];

  const MESES_NOME = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
  ];

  /** Compatibilidade com lançamentos antigos (quem pagou). */
  const LEGACY_COMPRADORES = {
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
    outro: "Outro",
  };

  let state = loadState();
  let usuarioAtualId = localStorage.getItem(SESSION_KEY) || null;
  let codigoCasa = localStorage.getItem(CASA_KEY) || CASA_PADRAO;
  let mesSelecionado = state.mesAtual || state.meses[0]?.id || null;
  let relatorioModo = "casa"; // casa | vaquinha | pendencias
  let pessoalDonoId = null;
  let pessoalMesId = todayISO().slice(0, 7);
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
      const grupos = normalizarGrupos(parsed.grupos, parsed.pesos);
      const pesos = pesosFromGrupos(grupos);

      let meses = Array.isArray(parsed.meses) ? parsed.meses : [];
      let mesAtual = parsed.mesAtual || null;
      let lancamentos = Array.isArray(parsed.lancamentos) ? parsed.lancamentos : [];
      let pessoas = Array.isArray(parsed.pessoas) ? parsed.pessoas : [];
      let tiposDespesa = normalizarTiposDespesa(parsed.tiposDespesa);

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
        grupos,
        pesos,
        meses,
        mesAtual,
        pessoas,
        tiposDespesa,
        pendencias: Array.isArray(parsed.pendencias) ? parsed.pendencias : [],
        pessoais: Array.isArray(parsed.pessoais) ? parsed.pessoais : [],
        pessoalAcessos: Array.isArray(parsed.pessoalAcessos) ? parsed.pessoalAcessos : [],
        pessoalTipos: Array.isArray(parsed.pessoalTipos) ? parsed.pessoalTipos : [],
        pessoalCategorias: Array.isArray(parsed.pessoalCategorias) ? parsed.pessoalCategorias : [],
        pessoalPagamentos: Array.isArray(parsed.pessoalPagamentos) ? parsed.pessoalPagamentos : [],
        notificacoes: Array.isArray(parsed.notificacoes) ? parsed.notificacoes : [],
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    } catch {
      return defaultState();
    }
  }

  function defaultState() {
    const grupos = DEFAULT_GRUPOS.map((g) => ({ ...g }));
    return {
      lancamentos: [],
      grupos,
      pesos: pesosFromGrupos(grupos),
      meses: [],
      mesAtual: null,
      pessoas: [],
      tiposDespesa: DEFAULT_TIPOS_DESPESA.map((t) => ({ ...t })),
      pendencias: [],
      pessoais: [],
      pessoalAcessos: [],
      pessoalTipos: [],
      pessoalCategorias: [],
      pessoalPagamentos: [],
      notificacoes: [],
      updatedAt: 0,
    };
  }

  function normalizarGrupos(lista, pesosLegacy) {
    if (Array.isArray(lista) && lista.length) {
      const vistos = new Set();
      const out = [];
      lista.forEach((g, i) => {
        const id = String(g?.id || `g${i + 1}`).trim() || `g${i + 1}`;
        if (vistos.has(id)) return;
        const nome = String(g?.nome || `Grupo ${i + 1}`)
          .trim()
          .replace(/\s+/g, " ");
        const peso = Number(g?.peso);
        if (!nome || !(peso > 0)) return;
        vistos.add(id);
        out.push({ id, nome, peso });
      });
      if (out.length) return out;
    }
    return DEFAULT_GRUPOS.map((g) => ({
      ...g,
      peso: Number(pesosLegacy?.[g.id]) > 0 ? Number(pesosLegacy[g.id]) : g.peso,
    }));
  }

  function pesosFromGrupos(grupos = state.grupos) {
    const out = {};
    (grupos || []).forEach((g) => {
      out[g.id] = Number(g.peso) || 0;
    });
    return out;
  }

  function nextGrupoId(grupos = state.grupos) {
    const ids = new Set((grupos || []).map((g) => g.id));
    let n = 1;
    while (ids.has(`g${n}`)) n += 1;
    return `g${n}`;
  }

  function labelComprador(id) {
    if (!id) return "—";
    const g = (state.grupos || []).find((x) => x.id === id);
    if (g) return g.nome;
    return LEGACY_COMPRADORES[id]?.label || id;
  }

  function normalizarTiposDespesa(lista) {
    if (!Array.isArray(lista) || !lista.length) {
      return DEFAULT_TIPOS_DESPESA.map((t) => ({ ...t }));
    }
    const vistos = new Set();
    const out = [];
    lista.forEach((t) => {
      const nome = String(typeof t === "string" ? t : t?.nome || "")
        .trim()
        .replace(/\s+/g, " ");
      if (!nome) return;
      const chave = nome.toLowerCase();
      if (vistos.has(chave)) return;
      vistos.add(chave);
      out.push({
        id: (typeof t === "object" && t?.id) || `td-${uid()}`,
        nome,
      });
    });
    out.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    return out.length ? out : DEFAULT_TIPOS_DESPESA.map((t) => ({ ...t }));
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
      grupos: state.grupos,
      pesos: pesosFromGrupos(state.grupos),
      meses: state.meses,
      mesAtual: state.mesAtual,
      pessoas: state.pessoas,
      tiposDespesa: state.tiposDespesa,
      pendencias: state.pendencias,
      pessoais: state.pessoais,
      pessoalAcessos: state.pessoalAcessos,
      pessoalTipos: state.pessoalTipos,
      pessoalCategorias: state.pessoalCategorias,
      pessoalPagamentos: state.pessoalPagamentos,
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
    const grupos = normalizarGrupos(payload.grupos, payload.pesos);
    state = {
      lancamentos: Array.isArray(payload.lancamentos) ? payload.lancamentos : [],
      grupos,
      pesos: pesosFromGrupos(grupos),
      meses: Array.isArray(payload.meses) ? payload.meses : [],
      mesAtual: payload.mesAtual || null,
      pessoas: Array.isArray(payload.pessoas) ? payload.pessoas : [],
      tiposDespesa: normalizarTiposDespesa(payload.tiposDespesa),
      pendencias: Array.isArray(payload.pendencias) ? payload.pendencias : [],
      pessoais: Array.isArray(payload.pessoais) ? payload.pessoais : [],
      pessoalAcessos: Array.isArray(payload.pessoalAcessos) ? payload.pessoalAcessos : [],
      pessoalTipos: Array.isArray(payload.pessoalTipos) ? payload.pessoalTipos : [],
      pessoalCategorias: Array.isArray(payload.pessoalCategorias) ? payload.pessoalCategorias : [],
      pessoalPagamentos: Array.isArray(payload.pessoalPagamentos) ? payload.pessoalPagamentos : [],
      notificacoes: Array.isArray(payload.notificacoes) ? payload.notificacoes : [],
      updatedAt: remoteAt || Date.now(),
    };
    state.lancamentos = state.lancamentos.map((l) => migrarVaquinha(l));
    const pendenciasReparadas = normalizarPendenciasIds();
    if (pendenciasReparadas) state.updatedAt = Date.now();
    lastRemoteUpdatedAt = remoteAt || state.updatedAt;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (pendenciasReparadas) {
      setTimeout(() => {
        if (!applyingRemote) schedulePush();
      }, 0);
    }

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
      renderMercadoLista();
      renderDespesaLista();
      renderPendencias();
      fillPendenciaPessoas();
      renderPessoal();
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

  function somaPesos(grupos = state.grupos) {
    const lista = grupos || [];
    return Number(lista.reduce((acc, g) => acc + (Number(g.peso) || 0), 0).toFixed(4));
  }

  function dividirValor(valor, criterio, grupos = state.grupos) {
    const total = Number(valor) || 0;
    const lista = grupos || [];
    const out = {};
    if (!lista.length) return out;

    if (criterio === "igual_3") {
      const parte = total / lista.length;
      lista.forEach((g) => {
        out[g.id] = parte;
      });
      return out;
    }

    const soma = somaPesos(lista);
    if (soma <= 0) {
      lista.forEach((g) => {
        out[g.id] = 0;
      });
      return out;
    }
    lista.forEach((g) => {
      out[g.id] = total * ((Number(g.peso) || 0) / soma);
    });
    return out;
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

  /** Resolve pessoa por id; se o id sumiu (recadastro), tenta pelo nome. */
  function acharPessoaPorIdOuNome(id, nome) {
    if (id) {
      const byId = state.pessoas.find((p) => p.id === id);
      if (byId) return byId;
    }
    const n = String(nome || "")
      .trim()
      .toLowerCase();
    if (!n) return null;
    return state.pessoas.find((p) => p.nome.trim().toLowerCase() === n) || null;
  }

  /** Reata IDs de pendências a pessoas atuais (evita “fantasma” no relatório). */
  function normalizarPendenciasIds() {
    let mudou = false;
    (state.pendencias || []).forEach((p) => {
      const credor = acharPessoaPorIdOuNome(p.credorId, p.credorNome);
      if (credor && (p.credorId !== credor.id || p.credorNome !== credor.nome)) {
        p.credorId = credor.id;
        p.credorNome = credor.nome;
        mudou = true;
      }
      const devedor = acharPessoaPorIdOuNome(p.devedorId, p.devedorNome);
      if (devedor && (p.devedorId !== devedor.id || p.devedorNome !== devedor.nome)) {
        p.devedorId = devedor.id;
        p.devedorNome = devedor.nome;
        mudou = true;
      }
      const criador = acharPessoaPorIdOuNome(p.criadoPorId, p.criadoPorNome);
      if (criador && p.criadoPorId !== criador.id) {
        p.criadoPorId = criador.id;
        p.criadoPorNome = criador.nome;
        mudou = true;
      }
    });
    return mudou;
  }

  function usuarioNaPendencia(p, u) {
    if (!p || !u) return false;
    if (p.credorId === u.id || p.devedorId === u.id) return true;
    const n = u.nome.trim().toLowerCase();
    return (
      String(p.credorNome || "").trim().toLowerCase() === n ||
      String(p.devedorNome || "").trim().toLowerCase() === n
    );
  }

  function souCredorDaPendencia(p, u) {
    if (!p || !u) return false;
    if (p.credorId === u.id) return true;
    if (p.devedorId === u.id) return false;
    return String(p.credorNome || "").trim().toLowerCase() === u.nome.trim().toLowerCase();
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
  function buscarPessoaCadastrada(nomeRaw) {
    const nome = String(nomeRaw || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!nome) return null;
    return state.pessoas.find((p) => p.nome.toLowerCase() === nome.toLowerCase()) || null;
  }

  function bootstrapAdminSeVazio(nomeRaw) {
    if (state.pessoas.length) return null;
    const nome = String(nomeRaw || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!nome || nome.toLowerCase() !== ADMIN_NOME) return null;
    const pessoa = { id: uid(), nome };
    state.pessoas.push(pessoa);
    saveState();
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
    renderMercadoLista();
    renderDespesaLista();
    renderPendencias();
    fillPendenciaPessoas();
    pessoalDonoId = pessoa.id;
    pessoalMesId = currentMonthId();
    renderPessoal();
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
    const sel = $("#login-usuario");
    if (sel) sel.value = "";
    const adminInput = $("#login-nome-admin");
    if (adminInput) adminInput.value = "";
    if (codigoCasa) $("#login-casa").value = CASA_PADRAO;
    setSyncStatus(firebasePronto() ? (navigator.onLine ? "offline" : "offline") : "local");
    (sel || $("#login-nome-admin"))?.focus();
  }

  function renderLoginUI() {
    if ($("#login-casa")) $("#login-casa").value = CASA_PADRAO;
    setSyncStatus(firebasePronto() ? (navigator.onLine ? "online" : "offline") : "local");
    updateInstallHint();

    const select = $("#login-usuario");
    const campoUsuario = $("#login-campo-usuario");
    const campoAdmin = $("#login-campo-admin");
    const adminInput = $("#login-nome-admin");
    const vazio = !state.pessoas.length;

    if (campoUsuario) campoUsuario.classList.toggle("hidden", vazio);
    if (campoAdmin) campoAdmin.classList.toggle("hidden", !vazio);
    if (select) {
      select.required = !vazio;
      const prev = select.value;
      select.innerHTML =
        `<option value="">Selecione…</option>` +
        [...state.pessoas]
          .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
          .map((p) => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`)
          .join("");
      if (prev && state.pessoas.some((p) => p.id === prev)) select.value = prev;
    }
    if (adminInput) adminInput.required = vazio;
  }

  function initLogin() {
    $("#form-login").addEventListener("submit", async (e) => {
      e.preventDefault();
      const casa = CASA_PADRAO;
      const idAntes = $("#login-usuario")?.value || "";
      const nomeAntes = $("#login-usuario")?.selectedOptions?.[0]?.textContent?.trim() || "";
      const nomeAdmin = $("#login-nome-admin")?.value || "";

      await startSync(casa);
      renderLoginUI();

      let pessoa = null;
      if (!state.pessoas.length) {
        pessoa = bootstrapAdminSeVazio(nomeAdmin);
        if (!pessoa) {
          return toast("Primeiro acesso: use o nome do admin (Paulo).");
        }
      } else {
        pessoa =
          state.pessoas.find((p) => p.id === idAntes) ||
          buscarPessoaCadastrada(nomeAntes);
        if (!pessoa) {
          return toast("Usuário não cadastrado. Peça ao admin para cadastrar em Config.");
        }
      }

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
        if (tab === "encontro") renderEncontro();
        if (tab === "config") fillConfigForm();
        if (tab === "vaquinha") renderVaquinhaUI();
        if (tab === "despesas" || tab === "mercado") fillSelectCompradores();
        if (tab === "despesas") {
          fillSelectTiposDespesa();
          renderDespesaLista();
        }
        if (tab === "mercado") renderMercadoLista();
        if (tab === "pendencias") {
          fillPendenciaPessoas();
          renderPendencias();
        }
        if (tab === "pessoal") renderPessoal();
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
      el.disabled = !admin;
    });
    $("#form-pessoa")?.classList.toggle("hidden", !admin);
    $("#form-pessoa")?.classList.toggle("is-disabled", !admin);
  }

  function renderMercadoLista() {
    const box = $("#lista-mercado");
    const empty = $("#empty-mercado");
    const totalBox = $("#mercado-total");
    const countEl = $("#mercado-count");
    if (!box || !empty) return;

    const mesId = state.mesAtual || mesSelecionado;
    const podeExcluirMes = mesEstaAberto(mesId);
    const items = state.lancamentos
      .filter((l) => l.tipo === "mercado" && l.mesId === mesId)
      .sort((a, b) => {
        if (a.data === b.data) return (b.criadoEm || "").localeCompare(a.criadoEm || "");
        return b.data.localeCompare(a.data);
      });

    const total = items.reduce((acc, i) => acc + (Number(i.valor) || 0), 0);
    if (countEl) countEl.textContent = String(items.length);

    if (totalBox) {
      if (!items.length) {
        totalBox.classList.add("hidden");
        totalBox.innerHTML = "";
      } else {
        totalBox.classList.remove("hidden");
        const mesLabel = mesId ? labelMes(mesId) : "mês";
        totalBox.innerHTML = `
          <p class="mercado-total__label">Total mercado · ${escapeHtml(mesLabel)}</p>
          <p class="mercado-total__valor">${formatMoney(total)}</p>`;
      }
    }

    if (!items.length) {
      box.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    box.innerHTML = items
      .map((item) => {
        const meu = item.lancadoPorId && item.lancadoPorId === usuarioAtualId;
        const acao =
          meu && podeExcluirMes
            ? `<button type="button" class="btn btn--ghost btn--sm btn-excluir-mercado" data-id="${item.id}">Excluir</button>`
            : "";
        return `
      <article class="mercado-item">
        <div>
          <p class="mercado-item__meta">${formatDate(item.data)} · ${escapeHtml(PAGAMENTOS[item.pagamento] || item.pagamento || "—")}</p>
          <p class="mercado-item__detalhe">${escapeHtml(labelComprador(item.comprador))}</p>
        </div>
        <p class="mercado-item__valor">${formatMoney(item.valor)}</p>
        <div class="mercado-item__rodape">
          <p class="mercado-item__por">Por ${escapeHtml(item.lancadoPorNome || "—")}</p>
          ${acao}
        </div>
      </article>`;
      })
      .join("");

    box.querySelectorAll(".btn-excluir-mercado").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = state.lancamentos.find((l) => l.id === btn.dataset.id);
        if (!item || item.tipo !== "mercado") return;
        if (item.lancadoPorId !== usuarioAtualId) {
          return toast("Só quem lançou pode excluir.");
        }
        if (!mesEstaAberto(item.mesId)) {
          return toast("Só é possível excluir no mês aberto.");
        }
        if (!confirm(`Excluir mercado de ${formatMoney(item.valor)} (${formatDate(item.data)})?`)) return;

        const autor = autorMeta();
        state.lancamentos = state.lancamentos.filter((l) => l.id !== item.id);
        notificarTodosExceto(autor.lancadoPorId, {
          titulo: "Mercado excluído",
          texto: `${autor.lancadoPorNome} excluiu um mercado de ${formatMoney(item.valor)}.`,
          tipo: "exclusao",
          refId: item.id,
        });
        saveState();
        updateNotifBadge();
        renderMercadoLista();
        renderRelatorio();
        toast("Mercado excluído.");
      });
    });
  }

  function renderDespesaLista() {
    const box = $("#lista-despesa");
    const empty = $("#empty-despesa");
    const totalBox = $("#despesa-total");
    const countEl = $("#despesa-count");
    if (!box || !empty) return;

    const mesId = state.mesAtual || mesSelecionado;
    const podeExcluirMes = mesEstaAberto(mesId);
    const items = state.lancamentos
      .filter((l) => l.tipo === "despesa" && l.mesId === mesId)
      .sort((a, b) => {
        if (a.data === b.data) return (b.criadoEm || "").localeCompare(a.criadoEm || "");
        return b.data.localeCompare(a.data);
      });

    const total = items.reduce((acc, i) => acc + (Number(i.valor) || 0), 0);
    if (countEl) countEl.textContent = String(items.length);

    if (totalBox) {
      if (!items.length) {
        totalBox.classList.add("hidden");
        totalBox.innerHTML = "";
      } else {
        totalBox.classList.remove("hidden");
        const mesLabel = mesId ? labelMes(mesId) : "mês";
        totalBox.innerHTML = `
          <p class="mercado-total__label">Total despesas · ${escapeHtml(mesLabel)}</p>
          <p class="mercado-total__valor">${formatMoney(total)}</p>`;
      }
    }

    if (!items.length) {
      box.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    box.innerHTML = items
      .map((item) => {
        const meu = item.lancadoPorId && item.lancadoPorId === usuarioAtualId;
        const acao =
          meu && podeExcluirMes
            ? `<button type="button" class="btn btn--ghost btn--sm btn-excluir-despesa" data-id="${item.id}">Excluir</button>`
            : "";
        const crit = item.criterio === "igual_3" ? "Partes iguais" : "Proporcional";
        const pag = PAGAMENTOS[item.pagamento] || item.pagamento || "—";
        return `
      <article class="mercado-item">
        <div>
          <p class="mercado-item__meta">${formatDate(item.data)} · ${escapeHtml(pag)} · ${escapeHtml(crit)}</p>
          <p class="mercado-item__detalhe">${escapeHtml(item.descricao || "—")}</p>
          <p class="mercado-item__por" style="margin-top:0.2rem">${escapeHtml(labelComprador(item.comprador))}</p>
        </div>
        <p class="mercado-item__valor">${formatMoney(item.valor)}</p>
        <div class="mercado-item__rodape">
          <p class="mercado-item__por">Por ${escapeHtml(item.lancadoPorNome || "—")}</p>
          ${acao}
        </div>
      </article>`;
      })
      .join("");

    box.querySelectorAll(".btn-excluir-despesa").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = state.lancamentos.find((l) => l.id === btn.dataset.id);
        if (!item || item.tipo !== "despesa") return;
        if (item.lancadoPorId !== usuarioAtualId) {
          return toast("Só quem lançou pode excluir.");
        }
        if (!mesEstaAberto(item.mesId)) {
          return toast("Só é possível excluir no mês aberto.");
        }
        if (!confirm(`Excluir "${item.descricao}" de ${formatMoney(item.valor)}?`)) return;

        const autor = autorMeta();
        state.lancamentos = state.lancamentos.filter((l) => l.id !== item.id);
        notificarTodosExceto(autor.lancadoPorId, {
          titulo: "Despesa excluída",
          texto: `${autor.lancadoPorNome} excluiu "${item.descricao}" (${formatMoney(item.valor)}).`,
          tipo: "exclusao",
          refId: item.id,
        });
        saveState();
        updateNotifBadge();
        renderDespesaLista();
        renderRelatorio();
        toast("Despesa excluída.");
      });
    });
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
      fillSelectCompradores();
      renderMercadoLista();
      toast("Mercado lançado.");
    });

    $("#despesa-descricao").addEventListener("change", () => {
      const nome = $("#despesa-descricao").value.trim().toLowerCase();
      if (nome === "internet") {
        $("#despesa-criterio").value = "igual_3";
      } else if ($("#despesa-criterio").value === "igual_3") {
        $("#despesa-criterio").value = "proporcional";
      }
    });

    $("#form-tipo-despesa").addEventListener("submit", (e) => {
      e.preventDefault();
      const nome = $("#tipo-despesa-nome").value.trim().replace(/\s+/g, " ");
      if (!nome) return toast("Informe o nome da despesa.");
      if (state.tiposDespesa.some((t) => t.nome.toLowerCase() === nome.toLowerCase())) {
        return toast("Essa despesa já está cadastrada.");
      }
      state.tiposDespesa.push({ id: uid(), nome });
      state.tiposDespesa.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
      saveState();
      e.target.reset();
      renderTiposDespesa();
      toast(`"${nome}" cadastrada.`);
    });

    $("#form-despesa").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!mesAberto()) return toast("Abra um mês antes de lançar.");
      if (!state.tiposDespesa.length) return toast("Cadastre ao menos um tipo de despesa.");
      const descricao = $("#despesa-descricao").value.trim();
      const data = $("#despesa-data").value;
      const comprador = $("#despesa-comprador").value;
      const pagamento = $("#despesa-pagamento").value;
      const criterio = $("#despesa-criterio").value;
      const valor = Number($("#despesa-valor").value);
      if (!descricao || !data || !comprador || !pagamento || !criterio || !(valor > 0)) {
        return toast("Preencha todos os campos.");
      }
      if (!state.tiposDespesa.some((t) => t.nome === descricao)) {
        return toast("Selecione uma despesa cadastrada.");
      }
      if (data.slice(0, 7) !== state.mesAtual) return toast(`A data deve pertencer a ${labelMes(state.mesAtual)}.`);

      const autor = autorMeta();
      const item = {
        id: uid(),
        mesId: state.mesAtual,
        tipo: "despesa",
        descricao,
        data,
        comprador,
        pagamento,
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
      fillSelectTiposDespesa();
      fillSelectCompradores();
      renderDespesaLista();
      toast("Despesa lançada.");
    });

    $("#form-pessoa").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!isAdmin()) return toast("Somente o admin pode cadastrar usuários.");
      const nome = $("#pessoa-nome").value.trim().replace(/\s+/g, " ");
      if (!nome) return toast("Informe o nome.");
      if (state.pessoas.some((p) => p.nome.toLowerCase() === nome.toLowerCase())) {
        return toast("Esse usuário já está cadastrado.");
      }
      state.pessoas.push({ id: uid(), nome });
      state.pessoas.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
      saveState();
      e.target.reset();
      renderPessoasLista();
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
      if (!state.pessoas.length) return toast("Peça ao admin para cadastrar usuários.");
      adicionarLinhaCompra();
      atualizarPreviewVaquinha();
      updateMesStatus();
    });

    $("#form-grupos").addEventListener("submit", (e) => {
      e.preventDefault();
      const coletados = coletarGruposDoForm();
      if (!coletados.length) return toast("Cadastre ao menos um grupo.");
      if (coletados.some((g) => !g.nome)) return toast("Informe o nome de todos os grupos.");
      if (coletados.some((g) => !(g.peso > 0))) return toast("Pesos devem ser > 0.");
      const nomes = coletados.map((g) => g.nome.toLowerCase());
      if (new Set(nomes).size !== nomes.length) return toast("Nomes de grupos duplicados.");

      state.grupos = coletados;
      state.pesos = pesosFromGrupos(state.grupos);
      state.lancamentos = state.lancamentos.map((item) => {
        if (item.tipo === "vaquinha") return item;
        const crit = item.criterio === "igual_3" ? "igual_3" : "proporcional";
        return { ...item, divisao: dividirValor(item.valor, crit) };
      });
      const autor = autorMeta();
      notificarTodosExceto(autor.lancadoPorId, {
        titulo: "Grupos atualizados",
        texto: `${autor.lancadoPorNome} alterou os grupos/pesos da casa.`,
        tipo: "config",
      });
      saveState();
      updateNotifBadge();
      renderGruposConfig();
      fillSelectCompradores();
      renderRelatorio();
      toast("Grupos salvos.");
    });

    $("#btn-add-grupo").addEventListener("click", () => {
      const atuais = coletarGruposDoForm();
      const id = nextGrupoId(atuais);
      atuais.push({ id, nome: `Grupo ${atuais.length + 1}`, peso: 1 });
      renderGruposConfig(atuais);
    });

    $("#filtro-mes").addEventListener("change", (e) => {
      mesSelecionado = e.target.value || null;
      renderRelatorio();
      syncEncontroMes();
      renderEncontro();
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
      renderMercadoLista();
      renderDespesaLista();
      renderEncontro();
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
      renderMercadoLista();
      renderDespesaLista();
      renderEncontro();
      toast(`${aberto.label} fechado.`);
    });

    $("#btn-limpar").addEventListener("click", () => {
      if (!mesSelecionado) return toast("Selecione um mês.");
      if (!mesEstaAberto(mesSelecionado)) return toast("Só é possível limpar o mês aberto.");
      const label = labelMes(mesSelecionado);
      if (!confirm(`Apagar mercado e despesas de ${label}? (Vaquinhas não são apagadas.)`)) return;
      const autor = autorMeta();
      state.lancamentos = state.lancamentos.filter(
        (l) => !(l.mesId === mesSelecionado && (l.tipo === "mercado" || l.tipo === "despesa"))
      );
      notificarTodosExceto(autor.lancadoPorId, {
        titulo: "Mês limpo",
        texto: `${autor.lancadoPorNome} limpou mercado/despesas de ${label}.`,
        tipo: "mes",
      });
      saveState();
      updateNotifBadge();
      renderRelatorio();
      renderMercadoLista();
      renderDespesaLista();
      renderEncontro();
      toast(`Mercado e despesas de ${label} apagados.`);
    });

    initRelatorioSwitch();
    initEncontroUI();
    initPendencias();
    initPessoal();
    initNotifUI();
  }

  /* ---------- Despesas pessoais ---------- */
  function podeVerPessoalDe(donoId) {
    const u = usuarioAtual();
    if (!u || !donoId) return false;
    if (u.id === donoId) return true;
    return (state.pessoalAcessos || []).some(
      (a) => a.donoId === donoId && a.viewerId === u.id
    );
  }

  function podeEditarPessoalDe(donoId) {
    return podeVerPessoalDe(donoId);
  }

  function idsParticipantesPessoal(donoId, excetoId = null) {
    const ids = new Set([donoId]);
    (state.pessoalAcessos || []).forEach((a) => {
      if (a.donoId === donoId) ids.add(a.viewerId);
    });
    if (excetoId) ids.delete(excetoId);
    return [...ids].filter(Boolean);
  }

  function donosPessoalDisponiveis() {
    const u = usuarioAtual();
    if (!u) return [];
    const ids = new Set([u.id]);
    (state.pessoalAcessos || []).forEach((a) => {
      if (a.viewerId === u.id) ids.add(a.donoId);
    });
    return state.pessoas
      .filter((p) => ids.has(p.id))
      .sort((a, b) => {
        if (a.id === u.id) return -1;
        if (b.id === u.id) return 1;
        return a.nome.localeCompare(b.nome, "pt-BR");
      });
  }

  function limparDadosPessoalDaPessoa(pessoaId) {
    state.pessoais = (state.pessoais || []).filter((p) => p.donoId !== pessoaId);
    state.pessoalAcessos = (state.pessoalAcessos || []).filter(
      (a) => a.donoId !== pessoaId && a.viewerId !== pessoaId
    );
    state.pessoalTipos = (state.pessoalTipos || []).filter((t) => t.donoId !== pessoaId);
    state.pessoalCategorias = (state.pessoalCategorias || []).filter((c) => c.donoId !== pessoaId);
    state.pessoalPagamentos = (state.pessoalPagamentos || []).filter((p) => p.donoId !== pessoaId);
  }

  function listaCadastroPessoal(chave, donoId) {
    return (state[chave] || [])
      .filter((x) => x.donoId === donoId)
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }

  function ensurePessoalCadastros(donoId) {
    if (!donoId) return false;
    let mudou = false;
    const seed = (chave, nomes) => {
      if ((state[chave] || []).some((x) => x.donoId === donoId)) return;
      if (!Array.isArray(state[chave])) state[chave] = [];
      nomes.forEach((nome) => {
        state[chave].push({ id: uid(), donoId, nome });
      });
      mudou = true;
    };
    seed("pessoalTipos", DEFAULT_PESSOAL_TIPOS);
    seed("pessoalCategorias", DEFAULT_PESSOAL_CATEGORIAS);
    seed("pessoalPagamentos", DEFAULT_PESSOAL_PAGAMENTOS);
    return mudou;
  }

  function labelPagamentoPessoal(item) {
    if (item.pagamentoNome) return item.pagamentoNome;
    if (item.pagamentoId) {
      const p = (state.pessoalPagamentos || []).find((x) => x.id === item.pagamentoId);
      if (p) return p.nome;
    }
    return PAGAMENTOS[item.pagamento] || item.pagamento || "—";
  }

  function labelCategoriaPessoal(item) {
    if (item.categoriaNome) return item.categoriaNome;
    if (item.categoriaId) {
      const c = (state.pessoalCategorias || []).find((x) => x.id === item.categoriaId);
      if (c) return c.nome;
    }
    return item.categoria || "—";
  }

  function labelTipoPessoal(item) {
    if (item.tipoNome) return item.tipoNome;
    if (item.tipoId) {
      const t = (state.pessoalTipos || []).find((x) => x.id === item.tipoId);
      if (t) return t.nome;
    }
    return "—";
  }

  function fillPessoalMesSelect() {
    const select = $("#pessoal-mes");
    if (!select) return;
    const donoId = pessoalDonoId || usuarioAtualId;
    const meses = new Set([pessoalMesId || currentMonthId(), currentMonthId()]);
    (state.pessoais || [])
      .filter((p) => p.donoId === donoId)
      .forEach((p) => {
        const m = (p.data || "").slice(0, 7);
        if (m) meses.add(m);
      });
    const ordenados = [...meses].filter(Boolean).sort().reverse();
    if (!ordenados.includes(pessoalMesId)) pessoalMesId = ordenados[0] || currentMonthId();
    select.innerHTML = ordenados
      .map((id) => `<option value="${id}">${escapeHtml(labelMes(id))}</option>`)
      .join("");
    select.value = pessoalMesId;
  }

  function fillPessoalListaSelect() {
    const select = $("#pessoal-lista");
    if (!select) return;
    const u = usuarioAtual();
    const donos = donosPessoalDisponiveis();
    if (!pessoalDonoId || !donos.some((d) => d.id === pessoalDonoId)) {
      pessoalDonoId = u?.id || donos[0]?.id || null;
    }
    select.innerHTML = donos
      .map((p) => {
        const label = p.id === u?.id ? `${p.nome} (minha lista)` : p.nome;
        return `<option value="${p.id}">${escapeHtml(label)}</option>`;
      })
      .join("");
    if (pessoalDonoId) select.value = pessoalDonoId;
  }

  function fillPessoalViewerSelect() {
    const select = $("#pessoal-viewer");
    if (!select) return;
    const ja = new Set(
      (state.pessoalAcessos || [])
        .filter((a) => a.donoId === usuarioAtualId)
        .map((a) => a.viewerId)
    );
    const candidatos = state.pessoas.filter(
      (p) => p.id !== usuarioAtualId && !ja.has(p.id)
    );
    select.innerHTML =
      `<option value="">Selecione…</option>` +
      candidatos.map((p) => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join("");
  }

  function fillPessoalSelectsCadastro(donoId) {
    const tipos = listaCadastroPessoal("pessoalTipos", donoId);
    const cats = listaCadastroPessoal("pessoalCategorias", donoId);
    const pags = listaCadastroPessoal("pessoalPagamentos", donoId);

    const selTipo = $("#pessoal-tipo");
    const selCat = $("#pessoal-categoria");
    const selPag = $("#pessoal-pagamento");
    const prevTipo = selTipo?.value;
    const prevCat = selCat?.value;
    const prevPag = selPag?.value;

    if (selTipo) {
      selTipo.innerHTML =
        `<option value="">Selecione…</option>` +
        tipos.map((t) => `<option value="${t.id}">${escapeHtml(t.nome)}</option>`).join("");
      if (prevTipo && tipos.some((t) => t.id === prevTipo)) selTipo.value = prevTipo;
    }
    if (selCat) {
      selCat.innerHTML =
        `<option value="">Selecione…</option>` +
        cats.map((c) => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join("");
      if (prevCat && cats.some((c) => c.id === prevCat)) selCat.value = prevCat;
    }
    if (selPag) {
      selPag.innerHTML =
        `<option value="">Selecione…</option>` +
        pags.map((p) => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join("");
      if (prevPag && pags.some((p) => p.id === prevPag)) selPag.value = prevPag;
    }
  }

  function renderListaCadastroPessoal({ chave, listaId, emptyId, btnClass, podeEditar }) {
    const lista = $(listaId);
    const empty = $(emptyId);
    if (!lista || !empty) return;
    const donoId = pessoalDonoId || usuarioAtualId;
    const items = listaCadastroPessoal(chave, donoId);

    if (!items.length) {
      lista.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    lista.innerHTML = items
      .map(
        (item) => `
      <li class="lista-pessoas__item">
        <span>${escapeHtml(item.nome)}</span>
        ${
          podeEditar
            ? `<button type="button" class="btn btn--icon ${btnClass}" data-id="${item.id}" title="Remover">×</button>`
            : ""
        }
      </li>`
      )
      .join("");

    lista.querySelectorAll(`.${btnClass}`).forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!podeEditarPessoalDe(donoId)) return toast("Sem permissão.");
        const item = (state[chave] || []).find((x) => x.id === btn.dataset.id);
        if (!item || item.donoId !== donoId) return;
        if (!confirm(`Remover "${item.nome}"?`)) return;
        state[chave] = state[chave].filter((x) => x.id !== item.id);
        saveState();
        renderPessoal();
        toast("Removido.");
      });
    });
  }

  function renderPessoalCadastros(donoId, podeEditar) {
    const box = $("#pessoal-cadastros");
    if (box) {
      box.classList.toggle("hidden", !podeEditar);
      $$("#pessoal-cadastros input, #pessoal-cadastros button").forEach((el) => {
        el.disabled = !podeEditar;
      });
    }
    if (!podeEditar) return;

    renderListaCadastroPessoal({
      chave: "pessoalTipos",
      listaId: "#lista-pessoal-tipos",
      emptyId: "#empty-pessoal-tipos",
      btnClass: "btn-rm-pessoal-tipo",
      podeEditar,
    });
    renderListaCadastroPessoal({
      chave: "pessoalCategorias",
      listaId: "#lista-pessoal-cats",
      emptyId: "#empty-pessoal-cats",
      btnClass: "btn-rm-pessoal-cat",
      podeEditar,
    });
    renderListaCadastroPessoal({
      chave: "pessoalPagamentos",
      listaId: "#lista-pessoal-pags",
      emptyId: "#empty-pessoal-pags",
      btnClass: "btn-rm-pessoal-pag",
      podeEditar,
    });
  }

  function adicionarCadastroPessoal(chave, inputId, rotulo) {
    const u = usuarioAtual();
    if (!u) return;
    const donoId = pessoalDonoId || u.id;
    if (!podeEditarPessoalDe(donoId)) return toast("Sem permissão.");
    const input = $(inputId);
    const nome = (input?.value || "").trim().replace(/\s+/g, " ");
    if (!nome) return toast(`Informe o nome d${rotulo}.`);
    if (!Array.isArray(state[chave])) state[chave] = [];
    if (
      state[chave].some(
        (x) => x.donoId === donoId && x.nome.toLowerCase() === nome.toLowerCase()
      )
    ) {
      return toast("Já cadastrado.");
    }
    state[chave].push({ id: uid(), donoId, nome });
    if (input) input.value = "";
    saveState();
    renderPessoal();
    toast(`${nome} adicionado.`);
  }

  function renderPessoalAcessos() {
    const lista = $("#lista-pessoal-acessos");
    const empty = $("#empty-pessoal-acessos");
    const box = $("#pessoal-compartilhar");
    if (!lista || !empty || !box) return;

    const souDono = pessoalDonoId === usuarioAtualId;
    box.classList.toggle("hidden", !souDono);
    if (!souDono) return;

    const acessos = (state.pessoalAcessos || []).filter((a) => a.donoId === usuarioAtualId);
    fillPessoalViewerSelect();

    if (!acessos.length) {
      lista.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    lista.innerHTML = acessos
      .map((a) => {
        const nome =
          state.pessoas.find((p) => p.id === a.viewerId)?.nome || a.viewerNome || "—";
        return `
      <li class="lista-pessoas__item">
        <span>${escapeHtml(nome)}</span>
        <button type="button" class="btn btn--icon btn-revogar-pessoal" data-id="${a.id}" title="Remover acesso">×</button>
      </li>`;
      })
      .join("");

    lista.querySelectorAll(".btn-revogar-pessoal").forEach((btn) => {
      btn.addEventListener("click", () => {
        const acesso = (state.pessoalAcessos || []).find((a) => a.id === btn.dataset.id);
        if (!acesso || acesso.donoId !== usuarioAtualId) return;
        if (!confirm(`Remover o acesso de ${acesso.viewerNome || "este usuário"}?`)) return;
        state.pessoalAcessos = state.pessoalAcessos.filter((a) => a.id !== acesso.id);
        notificar({
          paraUserIds: [acesso.viewerId],
          titulo: "Acesso removido",
          texto: `${usuarioAtual()?.nome || "Alguém"} removeu seu acesso à lista pessoal compartilhada.`,
          tipo: "pessoal",
          refId: acesso.id,
        });
        saveState();
        updateNotifBadge();
        renderPessoal();
        toast("Acesso removido.");
      });
    });
  }

  function renderPessoal() {
    const u = usuarioAtual();
    if (!u) return;

    fillPessoalListaSelect();
    fillPessoalMesSelect();

    const donoId = pessoalDonoId || u.id;
    if (ensurePessoalCadastros(donoId)) saveState();

    const podeVer = podeVerPessoalDe(donoId);
    const podeEditar = podeEditarPessoalDe(donoId);
    const souDono = donoId === u.id;
    const form = $("#form-pessoal");
    const aviso = $("#aviso-pessoal-compartilhada");

    fillPessoalSelectsCadastro(donoId);
    renderPessoalCadastros(donoId, podeEditar);

    if (form) {
      form.classList.toggle("hidden", !podeEditar);
      $$("#form-pessoal input, #form-pessoal select, #form-pessoal button").forEach((el) => {
        el.disabled = !podeEditar;
      });
    }
    aviso?.classList.toggle("hidden", souDono || !podeVer);

    renderPessoalAcessos();

    const box = $("#lista-pessoal");
    const empty = $("#empty-pessoal");
    const totalBox = $("#pessoal-total");
    const porCatBox = $("#pessoal-por-categoria");
    const countEl = $("#pessoal-count");
    if (!box || !empty) return;

    if (!podeVer) {
      box.innerHTML = "";
      empty.textContent = "Você não tem acesso a esta lista.";
      empty.classList.remove("hidden");
      if (countEl) countEl.textContent = "0";
      totalBox?.classList.add("hidden");
      if (porCatBox) porCatBox.innerHTML = "";
      return;
    }

    const mesId = pessoalMesId || currentMonthId();
    const items = (state.pessoais || [])
      .filter((p) => p.donoId === donoId && (p.data || "").slice(0, 7) === mesId)
      .sort((a, b) => {
        if (a.data === b.data) return (b.criadoEm || "").localeCompare(a.criadoEm || "");
        return (b.data || "").localeCompare(a.data || "");
      });

    const total = items.reduce((acc, i) => acc + (Number(i.valor) || 0), 0);
    if (countEl) countEl.textContent = String(items.length);

    if (totalBox) {
      if (!items.length) {
        totalBox.classList.add("hidden");
        totalBox.innerHTML = "";
      } else {
        totalBox.classList.remove("hidden");
        const donoNome =
          state.pessoas.find((p) => p.id === donoId)?.nome ||
          (souDono ? "Você" : "—");
        const tituloLista = souDono ? "Minha lista" : `Lista de ${donoNome}`;
        totalBox.innerHTML = `
          <p class="mercado-total__label">${escapeHtml(tituloLista)} · ${escapeHtml(labelMes(mesId))}</p>
          <p class="mercado-total__valor">${formatMoney(total)}</p>`;
      }
    }

    if (porCatBox) {
      if (!items.length) {
        porCatBox.innerHTML = "";
      } else {
        const mapa = {};
        items.forEach((item) => {
          const nome = labelCategoriaPessoal(item) || "Sem categoria";
          mapa[nome] = (mapa[nome] || 0) + (Number(item.valor) || 0);
        });
        const linhas = Object.entries(mapa).sort((a, b) => b[1] - a[1]);
        porCatBox.innerHTML = `
          <div class="card-resumo">
            <p class="card-resumo__label">Por categoria</p>
            <div class="grupos-grid" style="margin-top:0.6rem">
              ${linhas
                .map(
                  ([nome, valor]) => `
                <div class="card-grupo">
                  <p class="card-grupo__nome">${escapeHtml(nome)}</p>
                  <p class="card-grupo__valor">${formatMoney(valor)}</p>
                </div>`
                )
                .join("")}
            </div>
          </div>`;
      }
    }

    if (!items.length) {
      box.innerHTML = "";
      empty.textContent = "Nenhuma despesa pessoal neste mês.";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    box.innerHTML = items
      .map((item) => {
        const tipo = labelTipoPessoal(item);
        const pag = labelPagamentoPessoal(item);
        const cat = labelCategoriaPessoal(item);
        const por = item.criadoPorNome
          ? `<p class="mercado-item__por">por ${escapeHtml(item.criadoPorNome)}</p>`
          : "";
        const acao = podeEditar
          ? `<button type="button" class="btn btn--ghost btn--sm btn-excluir-pessoal" data-id="${item.id}">Excluir</button>`
          : "";
        return `
      <article class="mercado-item">
        <div>
          <p class="mercado-item__meta">${formatDate(item.data)} · ${escapeHtml(tipo)} · ${escapeHtml(cat)} · ${escapeHtml(pag)}</p>
          <p class="mercado-item__detalhe">${escapeHtml(item.descricao)}</p>
          ${por}
        </div>
        <div class="mercado-item__rodape">
          <p class="mercado-item__valor">${formatMoney(item.valor)}</p>
          ${acao}
        </div>
      </article>`;
      })
      .join("");

    box.querySelectorAll(".btn-excluir-pessoal").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = (state.pessoais || []).find((p) => p.id === btn.dataset.id);
        if (!item || !podeEditarPessoalDe(item.donoId)) {
          return toast("Sem permissão para excluir nesta lista.");
        }
        if (!confirm(`Excluir "${item.descricao}" (${formatMoney(item.valor)})?`)) return;
        const autor = usuarioAtual();
        state.pessoais = state.pessoais.filter((p) => p.id !== item.id);
        const outros = idsParticipantesPessoal(item.donoId, autor?.id);
        if (outros.length) {
          notificar({
            paraUserIds: outros,
            titulo: "Despesa pessoal excluída",
            texto: `${autor?.nome || "Alguém"} excluiu "${item.descricao}" (${formatMoney(item.valor)}).`,
            tipo: "pessoal",
            refId: item.id,
          });
        }
        saveState();
        updateNotifBadge();
        renderPessoal();
        toast("Despesa pessoal excluída.");
      });
    });
  }

  function initPessoal() {
    const dataEl = $("#pessoal-data");
    if (dataEl) dataEl.value = todayISO();

    $("#pessoal-lista")?.addEventListener("change", (e) => {
      pessoalDonoId = e.target.value || usuarioAtualId;
      renderPessoal();
    });

    $("#pessoal-mes")?.addEventListener("change", (e) => {
      pessoalMesId = e.target.value || currentMonthId();
      renderPessoal();
    });

    $("#btn-add-pessoal-tipo")?.addEventListener("click", () =>
      adicionarCadastroPessoal("pessoalTipos", "#pessoal-tipo-nome", "o tipo")
    );
    $("#btn-add-pessoal-cat")?.addEventListener("click", () =>
      adicionarCadastroPessoal("pessoalCategorias", "#pessoal-cat-nome", "a categoria")
    );
    $("#btn-add-pessoal-pag")?.addEventListener("click", () =>
      adicionarCadastroPessoal("pessoalPagamentos", "#pessoal-pag-nome", "a forma de pagamento")
    );

    ["#pessoal-tipo-nome", "#pessoal-cat-nome", "#pessoal-pag-nome"].forEach((sel) => {
      $(sel)?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (sel.includes("tipo")) $("#btn-add-pessoal-tipo")?.click();
        else if (sel.includes("cat")) $("#btn-add-pessoal-cat")?.click();
        else $("#btn-add-pessoal-pag")?.click();
      });
    });

    $("#form-pessoal")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const u = usuarioAtual();
      if (!u) return toast("Faça login.");
      const donoId = pessoalDonoId || u.id;
      if (!podeEditarPessoalDe(donoId)) {
        return toast("Sem permissão para lançar nesta lista.");
      }
      const dono = state.pessoas.find((p) => p.id === donoId) || u;
      const descricao = $("#pessoal-descricao").value.trim();
      const data = $("#pessoal-data").value;
      const tipoId = $("#pessoal-tipo").value;
      const categoriaId = $("#pessoal-categoria").value;
      const pagamentoId = $("#pessoal-pagamento").value;
      const valor = Number($("#pessoal-valor").value);
      const tipo = (state.pessoalTipos || []).find((t) => t.id === tipoId && t.donoId === donoId);
      const categoria = (state.pessoalCategorias || []).find(
        (c) => c.id === categoriaId && c.donoId === donoId
      );
      const pagamento = (state.pessoalPagamentos || []).find(
        (p) => p.id === pagamentoId && p.donoId === donoId
      );

      if (!descricao || !data || !(valor > 0)) {
        return toast("Preencha descrição, data e valor.");
      }
      if (!tipo || !categoria || !pagamento) {
        return toast("Selecione tipo, categoria e forma de pagamento.");
      }

      const item = {
        id: uid(),
        donoId: dono.id,
        donoNome: dono.nome,
        descricao,
        data,
        tipoId: tipo.id,
        tipoNome: tipo.nome,
        categoriaId: categoria.id,
        categoriaNome: categoria.nome,
        categoria: categoria.nome,
        pagamentoId: pagamento.id,
        pagamentoNome: pagamento.nome,
        pagamento: pagamento.nome,
        valor,
        criadoPorId: u.id,
        criadoPorNome: u.nome,
        criadoEm: new Date().toISOString(),
      };
      if (!Array.isArray(state.pessoais)) state.pessoais = [];
      state.pessoais.unshift(item);

      const outros = idsParticipantesPessoal(dono.id, u.id);
      if (outros.length) {
        notificar({
          paraUserIds: outros,
          titulo: "Nova despesa pessoal",
          texto: `${u.nome} lançou "${descricao}" (${categoria.nome}) de ${formatMoney(valor)}.`,
          tipo: "pessoal",
          refId: item.id,
        });
      }

      saveState();
      updateNotifBadge();
      e.target.reset();
      $("#pessoal-data").value = todayISO();
      pessoalDonoId = dono.id;
      pessoalMesId = data.slice(0, 7);
      renderPessoal();
      toast("Despesa pessoal salva.");
    });

    $("#btn-pessoal-compartilhar")?.addEventListener("click", () => {
      const u = usuarioAtual();
      if (!u) return;
      const viewerId = $("#pessoal-viewer")?.value;
      const viewer = state.pessoas.find((p) => p.id === viewerId);
      if (!viewer) return toast("Selecione um usuário.");
      const ja = (state.pessoalAcessos || []).some(
        (a) => a.donoId === u.id && a.viewerId === viewer.id
      );
      if (ja) return toast("Esse usuário já está na lista.");

      if (!Array.isArray(state.pessoalAcessos)) state.pessoalAcessos = [];
      const acesso = {
        id: uid(),
        donoId: u.id,
        viewerId: viewer.id,
        viewerNome: viewer.nome,
        criadoEm: new Date().toISOString(),
      };
      state.pessoalAcessos.push(acesso);
      notificar({
        paraUserIds: [viewer.id],
        titulo: "Lista pessoal compartilhada",
        texto: `${u.nome} convidou você para dividir a lista pessoal — podem lançar e excluir juntos.`,
        tipo: "pessoal",
        refId: acesso.id,
      });
      saveState();
      updateNotifBadge();
      renderPessoal();
      toast(`${viewer.nome} agora divide sua lista.`);
    });
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
    const resumo = $("#resumo-pendencias");
    const u = usuarioAtual();
    if (!u) return;

    if (normalizarPendenciasIds()) saveState();

    const items = state.pendencias.filter((p) => usuarioNaPendencia(p, u));
    const abertas = items.filter((p) => p.status === "pendente");

    $("#pendencias-count").textContent = `${items.length} ite${items.length === 1 ? "m" : "ns"}`;

    // Cards por pessoa (somente pendentes)
    const porPessoa = {};
    abertas.forEach((p) => {
      const souCredor = souCredorDaPendencia(p, u);
      const outraId = souCredor ? p.devedorId : p.credorId;
      const outraNome = souCredor ? p.devedorNome : p.credorNome;
      const chave = outraId || outraNome || "outro";
      if (!porPessoa[chave]) {
        porPessoa[chave] = { id: outraId, nome: outraNome, receber: 0, pagar: 0 };
      }
      if (souCredor) porPessoa[chave].receber += Number(p.valor) || 0;
      else porPessoa[chave].pagar += Number(p.valor) || 0;
    });

    const cards = Object.values(porPessoa).sort((a, b) =>
      a.nome.localeCompare(b.nome, "pt-BR")
    );

    const totalReceber = cards.reduce((acc, c) => acc + c.receber, 0);
    const totalPagar = cards.reduce((acc, c) => acc + c.pagar, 0);

    if (resumo) {
      if (!cards.length) {
        resumo.innerHTML = `
          <div class="card-resumo">
            <p class="card-resumo__label">Resumo entre nós</p>
            <p class="card-resumo__valor" style="font-size:1.1rem;color:var(--ink-muted)">Nada pendente</p>
            <p class="card-resumo__meta">Quando houver valores em aberto, o saldo por pessoa aparece aqui.</p>
          </div>`;
      } else {
        resumo.innerHTML = `
          <div class="card-resumo card-resumo--total">
            <p class="card-resumo__label">Seu resumo aberto</p>
            <p class="card-resumo__valor" style="font-size:1.25rem">
              Receber ${formatMoney(totalReceber)} · Pagar ${formatMoney(totalPagar)}
            </p>
            <p class="card-resumo__meta">${cards.length} pessoa(s) com pendência</p>
          </div>
          <div class="grupos-grid">
            ${cards
              .map((c) => {
                const saldo = c.receber - c.pagar;
                let saldoTxt = "Quitados entre vocês";
                let saldoClass = "saldo--ok";
                if (saldo > 0.004) {
                  saldoTxt = `Saldo: a receber ${formatMoney(saldo)}`;
                  saldoClass = "saldo--receber";
                } else if (saldo < -0.004) {
                  saldoTxt = `Saldo: a pagar ${formatMoney(Math.abs(saldo))}`;
                  saldoClass = "saldo--pagar";
                }
                return `
              <div class="card-grupo">
                <p class="card-grupo__nome">${escapeHtml(c.nome)}</p>
                <p class="card-grupo__peso">A receber <strong class="saldo--receber">${formatMoney(c.receber)}</strong></p>
                <p class="card-grupo__peso">A pagar <strong class="saldo--pagar">${formatMoney(c.pagar)}</strong></p>
                <p class="card-grupo__valor ${saldoClass}" style="font-size:0.95rem;margin-top:0.45rem">${saldoTxt}</p>
              </div>`;
              })
              .join("")}
          </div>`;
      }
    }

    if (!items.length) {
      box.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    box.innerHTML = items
      .map((p) => {
        const souCredor = souCredorDaPendencia(p, u);
        const tipoLabel = souCredor ? "A receber" : "A pagar";
        const outra = souCredor ? p.devedorNome : p.credorNome;
        const tipoClass = souCredor ? "pendencia--receber" : "pendencia--pagar";
        const statusBadge =
          p.status === "pago"
            ? `<span class="badge badge--aberto">Pago</span>`
            : `<span class="badge badge--fechado">Pendente</span>`;

        const acoes = [];
        if (p.status === "pendente") {
          acoes.push(
            `<button type="button" class="btn btn--primary btn--sm btn-pagar-pend" data-id="${p.id}">Marcar como pago</button>`
          );
        } else {
          acoes.push(`<span class="detalhe">Pago em ${formatDateTime(p.pagoEm)}</span>`);
        }
        const souCriador =
          p.criadoPorId === u.id ||
          String(p.criadoPorNome || "").trim().toLowerCase() === u.nome.trim().toLowerCase();
        if (souCriador) {
          acoes.push(
            `<button type="button" class="btn btn--ghost btn--sm btn-excluir-pend" data-id="${p.id}">Excluir</button>`
          );
        }

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
            <div class="pendencia__acoes">${acoes.join("")}</div>
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

        const eu = usuarioAtual();
        const outroId = souCredorDaPendencia(pend, eu) ? pend.devedorId : pend.credorId;
        notificar({
          paraUserIds: [outroId].filter(Boolean),
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

    box.querySelectorAll(".btn-excluir-pend").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pend = state.pendencias.find((p) => p.id === btn.dataset.id);
        if (!pend) return;
        const eu = usuarioAtual();
        const souCriador =
          pend.criadoPorId === usuarioAtualId ||
          (eu &&
            String(pend.criadoPorNome || "").trim().toLowerCase() ===
              eu.nome.trim().toLowerCase());
        if (!souCriador) {
          return toast("Só quem lançou pode excluir.");
        }
        if (!confirm(`Excluir a pendência "${pend.descricao}"?`)) return;

        const outroId = souCredorDaPendencia(pend, eu) ? pend.devedorId : pend.credorId;
        const autor = autorMeta();
        state.pendencias = state.pendencias.filter((p) => p.id !== pend.id);
        notificar({
          paraUserIds: [outroId].filter(Boolean),
          titulo: "Pendência excluída",
          texto: `${autor.lancadoPorNome} excluiu "${pend.descricao}" (${formatMoney(pend.valor)}).`,
          tipo: "pendencia",
          refId: pend.id,
        });
        saveState();
        updateNotifBadge();
        renderPendencias();
        toast("Pendência excluída.");
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

  function grupoIdDoComprador(comprador) {
    if (!comprador) return null;
    if ((state.grupos || []).some((g) => g.id === comprador)) return comprador;
    return LEGACY_COMPRADORES[comprador]?.grupo || null;
  }

  function calcularSaldosGrupos(casa) {
    const grupos = state.grupos || [];
    const map = {};
    grupos.forEach((g) => {
      map[g.id] = { id: g.id, nome: g.nome, pagou: 0, cota: 0, saldo: 0 };
    });

    casa.forEach((item) => {
      const valor = Number(item.valor) || 0;
      const pagadorId = grupoIdDoComprador(item.comprador);
      // Sem quem pagou identificado, não entra no acerto entre grupos
      if (!pagadorId || !map[pagadorId]) return;

      map[pagadorId].pagou += valor;

      let div = item.divisao;
      if (!div || typeof div !== "object") {
        const crit = item.criterio === "igual_3" ? "igual_3" : "proporcional";
        div = dividirValor(valor, crit);
      }
      grupos.forEach((g) => {
        if (map[g.id]) map[g.id].cota += Number(div[g.id]) || 0;
      });
    });

    Object.values(map).forEach((g) => {
      g.saldo = g.pagou - g.cota;
    });
    return filtrarSaldosAtivos(Object.values(map));
  }

  /** Minimiza transferências: quem está negativo paga quem está positivo. */
  function calcularTransferencias(saldos) {
    const EPS = 0.005;
    const devedores = saldos
      .filter((s) => s.saldo < -EPS)
      .map((s) => ({ id: s.id, nome: s.nome, restante: -s.saldo }))
      .sort((a, b) => b.restante - a.restante);
    const credores = saldos
      .filter((s) => s.saldo > EPS)
      .map((s) => ({ id: s.id, nome: s.nome, restante: s.saldo }))
      .sort((a, b) => b.restante - a.restante);

    const transfers = [];
    let i = 0;
    let j = 0;
    while (i < devedores.length && j < credores.length) {
      const d = devedores[i];
      const c = credores[j];
      const valor = Math.min(d.restante, c.restante);
      if (valor > EPS) {
        transfers.push({
          deId: d.id,
          deNome: d.nome,
          paraId: c.id,
          paraNome: c.nome,
          valor,
        });
      }
      d.restante -= valor;
      c.restante -= valor;
      if (d.restante <= EPS) i += 1;
      if (c.restante <= EPS) j += 1;
    }
    return transfers;
  }

  function htmlBlocoAcerto({ titulo, meta, saldos, transfers, vazio, mostrarCabecalho = true }) {
    const saldosAtivos = filtrarSaldosAtivos(saldos);
    const transfersAtivas = (transfers || []).filter((t) => Number(t.valor) > 0.005);

    if (vazio || (!saldosAtivos.length && !transfersAtivas.length)) {
      return `
        <div class="card-resumo">
          <p class="card-resumo__label">${escapeHtml(titulo)}</p>
          <p class="card-resumo__meta" style="opacity:1;margin-top:0.35rem">Nada a acertar neste mês.</p>
        </div>`;
    }

    const cabecalho = mostrarCabecalho
      ? `
      <div class="card-resumo">
        <p class="card-resumo__label">${escapeHtml(titulo)}</p>
        <p class="card-resumo__meta" style="opacity:1;margin-top:0.25rem">${escapeHtml(meta)}</p>
      </div>`
      : "";

    const saldosHtml = saldosAtivos.length
      ? `
      <div class="grupos-grid">
        ${saldosAtivos
          .map((s) => {
            const t = textoSaldo(s.saldo);
            return `
          <div class="card-grupo">
            <p class="card-grupo__nome">${escapeHtml(s.nome)}</p>
            <p class="card-grupo__valor ${t.classe}">${t.texto}</p>
            <p class="card-grupo__peso">Cota ${formatMoney(s.cota)} · Pagou ${formatMoney(s.pagou)}</p>
          </div>`;
          })
          .join("")}
      </div>`
      : "";

    const transfersHtml = transfersAtivas.length
      ? `
      <div class="acerto-lista">
        <p class="acerto-lista__titulo">Quem passa pra quem</p>
        ${transfersAtivas
          .map(
            (t) => `
          <div class="acerto-item">
            <p class="acerto-item__fluxo">
              <strong>${escapeHtml(t.deNome)}</strong>
              <span class="acerto-item__seta" aria-hidden="true">→</span>
              <strong>${escapeHtml(t.paraNome)}</strong>
            </p>
            <p class="acerto-item__valor">${formatMoney(t.valor)}</p>
          </div>`
          )
          .join("")}
      </div>`
      : `<p class="fieldset__hint" style="margin:0.75rem 0 0">Todos quitados — nenhuma transferência.</p>`;

    return `${cabecalho}${saldosHtml}${transfersHtml}`;
  }

  function fillSelectTiposDespesa(selected = "") {
    const select = $("#despesa-descricao");
    if (!select) return;
    const atual = selected || select.value;
    const tipos = Array.isArray(state.tiposDespesa) ? state.tiposDespesa : [];
    select.innerHTML =
      `<option value="">Selecione…</option>` +
      tipos
        .map(
          (t) =>
            `<option value="${escapeHtml(t.nome)}"${t.nome === atual ? " selected" : ""}>${escapeHtml(t.nome)}</option>`
        )
        .join("");
  }

  function renderTiposDespesa() {
    if (!Array.isArray(state.tiposDespesa)) {
      state.tiposDespesa = normalizarTiposDespesa(null);
    }
    const lista = $("#lista-tipos-despesa");
    const empty = $("#empty-tipos-despesa");
    if (!lista) return;

    fillSelectTiposDespesa();

    if (!state.tiposDespesa.length) {
      lista.innerHTML = "";
      empty?.classList.remove("hidden");
      return;
    }
    empty?.classList.add("hidden");

    lista.innerHTML = state.tiposDespesa
      .map(
        (t) => `
      <li class="lista-pessoas__item">
        <span>${escapeHtml(t.nome)}</span>
        <button type="button" class="btn btn--icon btn-excluir-tipo-despesa" data-id="${t.id}" title="Remover">×</button>
      </li>`
      )
      .join("");

    lista.querySelectorAll(".btn-excluir-tipo-despesa").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const tipo = state.tiposDespesa.find((t) => t.id === id);
        if (!tipo) return;
        if (!confirm(`Remover "${tipo.nome}" da lista?`)) return;
        state.tiposDespesa = state.tiposDespesa.filter((t) => t.id !== id);
        saveState();
        renderTiposDespesa();
        toast("Despesa removida do cadastro.");
      });
    });
  }

  function renderPessoasLista() {
    const lista = $("#lista-pessoas");
    const empty = $("#empty-pessoas");
    if (!lista) return;

    if (!state.pessoas.length) {
      lista.innerHTML = "";
      empty?.classList.remove("hidden");
      return;
    }
    empty?.classList.add("hidden");

    lista.innerHTML = state.pessoas
      .map((p) => {
        const adminUser = p.nome.trim().toLowerCase() === ADMIN_NOME;
        const voce = p.id === usuarioAtualId;
        const meta = [adminUser ? "admin" : null, voce ? "você" : null].filter(Boolean).join(" · ");
        const podeRemover = isAdmin() && !adminUser && !voce;
        return `
      <li class="lista-pessoas__item">
        <span>${escapeHtml(p.nome)}${meta ? ` <span class="detalhe">(${meta})</span>` : ""}</span>
        ${
          podeRemover
            ? `<button type="button" class="btn btn--icon btn-excluir-pessoa" data-id="${p.id}" title="Remover">×</button>`
            : `<span class="badge badge--aberto">—</span>`
        }
      </li>`;
      })
      .join("");

    lista.querySelectorAll(".btn-excluir-pessoa").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!isAdmin()) return toast("Somente o admin pode remover usuários.");
        const id = btn.dataset.id;
        if (id === usuarioAtualId) return toast("Não é possível remover o usuário logado.");
        const pessoa = state.pessoas.find((p) => p.id === id);
        if (!pessoa) return;
        if (pessoa.nome.trim().toLowerCase() === ADMIN_NOME) {
          return toast("Não é possível remover o admin.");
        }
        if (!confirm(`Remover o usuário ${pessoa.nome}?`)) return;
        limparDadosPessoalDaPessoa(id);
        state.pessoas = state.pessoas.filter((p) => p.id !== id);
        saveState();
        renderPessoasLista();
        renderVaquinhaUI();
        fillPendenciaPessoas();
        renderLoginUI();
        renderPessoal();
        toast(`${pessoa.nome} removido(a).`);
      });
    });
  }

  function renderVaquinhaUI() {
    const boxPart = $("#vaquinha-participantes");
    const emptyPart = $("#empty-participantes");
    const boxCompras = $("#vaquinha-compras");
    if (!boxPart || !emptyPart || !boxCompras) return;

    if (!state.pessoas.length) {
      boxPart.innerHTML = "";
      emptyPart.classList.remove("hidden");
      boxCompras.innerHTML = "";
      $("#soma-pesos-vaquinha").textContent = "0";
      $("#total-compras-vaquinha").textContent = formatMoney(0);
      $("#preview-divisao").innerHTML = "";
      updateMesStatus();
      return;
    }

    emptyPart.classList.add("hidden");

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

  function fillSelectCompradores() {
    ["#mercado-comprador", "#despesa-comprador"].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      const atual = el.value;
      const grupos = state.grupos || [];
      el.innerHTML =
        `<option value="">Selecione…</option>` +
        grupos
          .map(
            (g) =>
              `<option value="${escapeHtml(g.id)}"${g.id === atual ? " selected" : ""}>${escapeHtml(g.nome)}</option>`
          )
          .join("");
    });
  }

  function coletarGruposDoForm() {
    const box = $("#lista-grupos-config");
    if (!box) return [...(state.grupos || [])];
    return $$(".grupo-row", box).map((row, i) => {
      const id = row.dataset.id || nextGrupoId();
      const nome = row.querySelector(".grupo-nome")?.value.trim().replace(/\s+/g, " ") || "";
      const peso = Number(row.querySelector(".grupo-peso")?.value);
      return { id, nome: nome || `Grupo ${i + 1}`, peso };
    });
  }

  function renderGruposConfig(lista) {
    const box = $("#lista-grupos-config");
    if (!box) return;
    const grupos = Array.isArray(lista) ? lista : state.grupos || [];
    box.innerHTML = grupos
      .map(
        (g) => `
      <div class="grupo-row" data-id="${escapeHtml(g.id)}">
        <label class="field field--grow">
          <span class="field__label">Nome</span>
          <input type="text" class="grupo-nome" value="${escapeHtml(g.nome)}" required />
        </label>
        <label class="field grupo-row__peso">
          <span class="field__label">Peso</span>
          <input type="number" class="grupo-peso" min="0.1" step="0.1" value="${Number(g.peso)}" required />
        </label>
        <button type="button" class="btn btn--icon btn-remover-grupo" title="Remover grupo" aria-label="Remover">×</button>
      </div>`
      )
      .join("");

    box.querySelectorAll(".grupo-peso, .grupo-nome").forEach((input) => {
      input.addEventListener("input", updateSomaPesos);
    });
    box.querySelectorAll(".btn-remover-grupo").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rows = $$(".grupo-row", box);
        if (rows.length <= 1) return toast("Mantenha ao menos um grupo.");
        btn.closest(".grupo-row")?.remove();
        updateSomaPesos();
      });
    });
    updateSomaPesos();
  }

  function fillConfigForm() {
    renderPessoasLista();
    renderGruposConfig();
    setSyncStatus(syncStatus);
    renderTiposDespesa();
    fillSelectCompradores();
    updateMesStatus();
  }

  function updateSomaPesos() {
    const el = $("#soma-pesos");
    if (!el) return;
    const soma = $$("#lista-grupos-config .grupo-peso").reduce(
      (acc, input) => acc + (Number(input.value) || 0),
      0
    );
    el.textContent = soma.toFixed(1);
  }

  function filtrarSaldosAtivos(saldos) {
    return (saldos || []).filter((s) => {
      if (!s?.id) return false;
      return (
        Math.abs(Number(s.saldo) || 0) > 0.005 ||
        Math.abs(Number(s.pagou) || 0) > 0.005 ||
        Math.abs(Number(s.cota) || 0) > 0.005
      );
    });
  }

  function calcularSaldosPessoasVaquinha(mesId) {
    const map = {};
    state.lancamentos
      .filter((l) => l.tipo === "vaquinha" && l.mesId === mesId)
      .forEach((v) => {
        const migrada = migrarVaquinha(v);
        const compras = Array.isArray(migrada.compras) ? migrada.compras : [];
        const base = (migrada.participantes || [])
          .map((p) => ({
            pessoaId: p.pessoaId,
            nome: p.nome,
            peso: Number(p.peso) || 1,
          }))
          .filter((p) => p.pessoaId);
        // Sem compras válidas, ignora (evita saldo fantasma guardado no JSON)
        if (!compras.length || !base.length) return;

        calcularAcerto(compras, base).forEach((p) => {
          if (!map[p.pessoaId]) {
            map[p.pessoaId] = { id: p.pessoaId, nome: p.nome, pagou: 0, cota: 0, saldo: 0 };
          }
          map[p.pessoaId].nome = p.nome || map[p.pessoaId].nome;
          map[p.pessoaId].pagou += Number(p.pagou) || 0;
          map[p.pessoaId].cota += Number(p.cota) || 0;
          map[p.pessoaId].saldo += Number(p.saldo) || 0;
        });
      });

    return filtrarSaldosAtivos(Object.values(map)).sort((a, b) =>
      a.nome.localeCompare(b.nome, "pt-BR")
    );
  }

  function calcularSaldosPendenciasMes(mesId) {
    const map = {};
    const ensure = (id, nome) => {
      const pessoa = acharPessoaPorIdOuNome(id, nome);
      const key = pessoa?.id || id || String(nome || "").trim().toLowerCase();
      if (!key) return null;
      const label = pessoa?.nome || nome || "—";
      if (!map[key]) map[key] = { id: key, nome: label, pagou: 0, cota: 0, saldo: 0 };
      else map[key].nome = label;
      return map[key];
    };
    state.pendencias
      .filter((p) => p.status === "pendente" && (p.data || "").slice(0, 7) === mesId)
      .forEach((p) => {
        const valor = Number(p.valor) || 0;
        if (!(valor > 0)) return;
        const credor = ensure(p.credorId, p.credorNome);
        const devedor = ensure(p.devedorId, p.devedorNome);
        if (!credor || !devedor || credor.id === devedor.id) return;
        // Credor deve receber => saldo positivo; devedor deve pagar => negativo
        credor.saldo += valor;
        credor.pagou += valor;
        devedor.saldo -= valor;
        devedor.cota += valor;
      });
    return filtrarSaldosAtivos(Object.values(map)).sort((a, b) =>
      a.nome.localeCompare(b.nome, "pt-BR")
    );
  }

  function mergeSaldosPessoas(listas) {
    const map = {};
    listas.flat().forEach((s) => {
      if (!s?.id) return;
      if (!map[s.id]) {
        map[s.id] = { id: s.id, nome: s.nome, pagou: 0, cota: 0, saldo: 0 };
      }
      map[s.id].nome = s.nome || map[s.id].nome;
      map[s.id].pagou += Number(s.pagou) || 0;
      map[s.id].cota += Number(s.cota) || 0;
      map[s.id].saldo += Number(s.saldo) || 0;
    });
    return filtrarSaldosAtivos(Object.values(map)).sort((a, b) =>
      a.nome.localeCompare(b.nome, "pt-BR")
    );
  }

  function syncEncontroMes() {
    const sel = $("#encontro-mes");
    if (!sel) return;
    const prev = sel.value || mesSelecionado;
    const ordenados = [...state.meses].sort((a, b) => b.id.localeCompare(a.id));
    if (!ordenados.length) {
      sel.innerHTML = `<option value="">Nenhum mês</option>`;
      return;
    }
    sel.innerHTML = ordenados
      .map((m) => {
        const tag = m.status === "aberto" ? " (aberto)" : " (fechado)";
        return `<option value="${m.id}">${m.label}${tag}</option>`;
      })
      .join("");
    if (prev && ordenados.some((m) => m.id === prev)) sel.value = prev;
    else if (state.mesAtual) sel.value = state.mesAtual;
    else sel.value = ordenados[0].id;
  }

  function initRelatorioSwitch() {
    $$(".relatorio-switch__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        relatorioModo = btn.dataset.rel || "casa";
        $$(".relatorio-switch__btn").forEach((b) => {
          b.classList.toggle("is-active", b.dataset.rel === relatorioModo);
        });
        $("#relatorio-casa")?.classList.toggle("hidden", relatorioModo !== "casa");
        $("#relatorio-vaquinha")?.classList.toggle("hidden", relatorioModo !== "vaquinha");
        $("#relatorio-pendencias")?.classList.toggle("hidden", relatorioModo !== "pendencias");
        renderRelatorio();
      });
    });
  }

  function initEncontroUI() {
    ["#enc-casa", "#enc-vaquinha", "#enc-pendencias", "#encontro-mes"].forEach((sel) => {
      $(sel)?.addEventListener("change", () => renderEncontro());
    });
  }

  function renderEncontro() {
    syncEncontroMes();
    const box = $("#encontro-resultado");
    if (!box) return;
    const mesId = $("#encontro-mes")?.value || mesSelecionado;
    if (!mesId) {
      box.innerHTML = `<div class="card-resumo"><p class="card-resumo__label">Encontro</p><p class="card-resumo__meta" style="opacity:1;margin-top:0.35rem">Selecione um mês.</p></div>`;
      return;
    }

    const useCasa = $("#enc-casa")?.checked;
    const useVaq = $("#enc-vaquinha")?.checked;
    const usePend = $("#enc-pendencias")?.checked;
    if (!useCasa && !useVaq && !usePend) {
      box.innerHTML = `<div class="card-resumo"><p class="card-resumo__label">Encontro</p><p class="card-resumo__meta" style="opacity:1;margin-top:0.35rem">Marque ao menos uma origem.</p></div>`;
      return;
    }

    const partes = [];
    partes.push(`
      <div class="card-resumo card-resumo--total">
        <p class="card-resumo__label">Encontro — ${escapeHtml(labelMes(mesId))}</p>
        <p class="card-resumo__meta">${[
          useCasa ? "Mercado+Despesas" : null,
          useVaq ? "Vaquinha" : null,
          usePend ? "Entre nós" : null,
        ]
          .filter(Boolean)
          .join(" · ")}</p>
      </div>`);

    if (useCasa) {
      const casa = state.lancamentos.filter(
        (l) => l.mesId === mesId && (l.tipo === "mercado" || l.tipo === "despesa")
      );
      const saldos = calcularSaldosGrupos(casa);
      const transfers = calcularTransferencias(saldos);
      partes.push(
        htmlBlocoAcerto({
          titulo: "1) Grupos da casa (mercado + despesas)",
          meta: "Transferências entre grupos.",
          saldos,
          transfers,
          vazio: !casa.length,
        })
      );
    }

    if (useVaq || usePend) {
      const listas = [];
      if (useVaq) listas.push(calcularSaldosPessoasVaquinha(mesId));
      if (usePend) listas.push(calcularSaldosPendenciasMes(mesId));
      const saldosP = mergeSaldosPessoas(listas);
      const transfersP = calcularTransferencias(saldosP);
      const fontes = [useVaq ? "vaquinha" : null, usePend ? "entre nós" : null]
        .filter(Boolean)
        .join(" + ");
      partes.push(
        htmlBlocoAcerto({
          titulo: `2) Pessoas (${fontes})`,
          meta: "Transferências entre usuários para fechar o encontro.",
          saldos: saldosP,
          transfers: transfersP,
          vazio: !saldosP.length,
        })
      );
    }

    box.innerHTML = partes.join("");
  }

  /* ---------- Relatório ---------- */
  function renderRelatorio() {
    fillFiltroMes();
    syncEncontroMes();
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

    $("#relatorio-casa")?.classList.toggle("hidden", relatorioModo !== "casa");
    $("#relatorio-vaquinha")?.classList.toggle("hidden", relatorioModo !== "vaquinha");
    $("#relatorio-pendencias")?.classList.toggle("hidden", relatorioModo !== "pendencias");
    $$(".relatorio-switch__btn").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.rel === relatorioModo);
    });

    if (relatorioModo === "vaquinha") {
      renderRelatorioVaquinha();
      return;
    }
    if (relatorioModo === "pendencias") {
      renderRelatorioPendencias();
      return;
    }
    renderRelatorioCasa();
  }

  function renderRelatorioCasa() {
    const items = state.lancamentos
      .filter((l) => l.mesId === mesSelecionado && (l.tipo === "mercado" || l.tipo === "despesa"))
      .sort((a, b) => {
        if (a.data === b.data) return (b.criadoEm || "").localeCompare(a.criadoEm || "");
        return b.data.localeCompare(a.data);
      });

    const totais = items.reduce(
      (acc, item) => {
        acc.geral += item.valor;
        (state.grupos || []).forEach((g) => {
          acc[g.id] = (acc[g.id] || 0) + (item.divisao?.[g.id] || 0);
        });
        return acc;
      },
      { geral: 0 }
    );

    const soma = somaPesos();
    const tituloMes = mesSelecionado ? labelMes(mesSelecionado) : "Nenhum mês";
    $("#resumo-cards").innerHTML = `
      <div class="card-resumo card-resumo--total">
        <p class="card-resumo__label">Mercado + Despesas — ${escapeHtml(tituloMes)}</p>
        <p class="card-resumo__valor">${formatMoney(totais.geral)}</p>
        <p class="card-resumo__meta">${items.length} lançamento(s) · pesos ${soma.toFixed(1)}</p>
      </div>
      <div class="grupos-grid">
        ${(state.grupos || [])
          .map((g) => {
            const valor = totais[g.id] || 0;
            const pct = soma > 0 ? ((Number(g.peso) / soma) * 100).toFixed(1) : "0.0";
            return `
          <div class="card-grupo">
            <p class="card-grupo__nome">${escapeHtml(g.nome)}</p>
            <p class="card-grupo__valor">${formatMoney(valor)}</p>
            <p class="card-grupo__peso">Peso ${Number(g.peso).toFixed(1)} · ${pct}%</p>
          </div>`;
          })
          .join("")}
      </div>`;

    const acertoBox = $("#resumo-acerto");
    if (acertoBox) {
      const saldos = calcularSaldosGrupos(items);
      const transfers = calcularTransferencias(saldos);
      acertoBox.innerHTML = htmlBlocoAcerto({
        titulo: `Acerto — ${tituloMes}`,
        meta: items.length
          ? "Somente mercado e despesas."
          : "Sem lançamentos de mercado/despesa.",
        saldos,
        transfers,
        vazio: !items.length,
      });
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

        let detalhe = "";
        if (item.tipo === "mercado") {
          detalhe = `${escapeHtml(labelComprador(item.comprador))}<br><span class="detalhe">${PAGAMENTOS[item.pagamento] || item.pagamento}</span>`;
        } else {
          const crit = item.criterio === "igual_3" ? "Partes iguais" : "Proporcional";
          const quem = item.comprador ? labelComprador(item.comprador) : null;
          const pag = item.pagamento ? PAGAMENTOS[item.pagamento] || item.pagamento : null;
          const extra = [quem, pag].filter(Boolean).join(" · ");
          detalhe = `${escapeHtml(item.descricao)}<br><span class="detalhe">${crit}${extra ? ` · ${escapeHtml(extra)}` : ""}</span>`;
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
        renderMercadoLista();
        renderDespesaLista();
        renderEncontro();
        toast("Excluído.");
      });
    });
  }

  function renderRelatorioVaquinha() {
    const vaquinhas = state.lancamentos
      .filter((l) => l.tipo === "vaquinha" && l.mesId === mesSelecionado)
      .sort((a, b) => b.data.localeCompare(a.data));
    const saldos = calcularSaldosPessoasVaquinha(mesSelecionado);
    const transfers = calcularTransferencias(saldos);
    const total = vaquinhas.reduce((acc, v) => acc + (Number(v.valor) || 0), 0);
    const tituloMes = mesSelecionado ? labelMes(mesSelecionado) : "Nenhum mês";

    $("#resumo-vaquinhas").innerHTML =
      `
      <div class="card-resumo">
        <p class="card-resumo__label">Vaquinhas — ${escapeHtml(tituloMes)}</p>
        <p class="card-resumo__valor" style="color:var(--brand)">${formatMoney(total)}</p>
        <p class="card-resumo__meta">${vaquinhas.length} vaquinha(s)</p>
      </div>` +
      htmlBlocoAcerto({
        titulo: "Acerto das vaquinhas",
        meta: "Quem passa pra quem só nas vaquinhas deste mês.",
        saldos,
        transfers,
        vazio: !vaquinhas.length,
        mostrarCabecalho: false,
      });

    $("#vaquinhas-rel-count").textContent = String(vaquinhas.length);
    const lista = $("#lista-rel-vaquinhas");
    const empty = $("#empty-rel-vaquinhas");
    if (!vaquinhas.length) {
      lista.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    lista.innerHTML = vaquinhas
      .map((v) => {
        const parts = (v.participantes || [])
          .map((p) => `${escapeHtml(p.nome)}: ${textoSaldo(p.saldo ?? 0).texto}`)
          .join(" · ");
        return `
      <article class="mercado-item">
        <div>
          <p class="mercado-item__meta">${formatDate(v.data)}</p>
          <p class="mercado-item__detalhe">${escapeHtml(v.descricao)}</p>
          <p class="mercado-item__por" style="margin-top:0.25rem">${parts || "—"}</p>
        </div>
        <p class="mercado-item__valor">${formatMoney(v.valor)}</p>
      </article>`;
      })
      .join("");
  }

  function renderRelatorioPendencias() {
    const mesId = mesSelecionado;
    const items = state.pendencias
      .filter((p) => (p.data || "").slice(0, 7) === mesId)
      .sort((a, b) => (b.data || "").localeCompare(a.data || ""));
    const abertas = items.filter((p) => p.status === "pendente");
    const saldos = calcularSaldosPendenciasMes(mesId);
    const transfers = calcularTransferencias(saldos);
    const total = abertas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    const tituloMes = mesId ? labelMes(mesId) : "Nenhum mês";

    $("#resumo-rel-pendencias").innerHTML =
      `
      <div class="card-resumo">
        <p class="card-resumo__label">Entre nós — ${escapeHtml(tituloMes)}</p>
        <p class="card-resumo__valor">${formatMoney(total)}</p>
        <p class="card-resumo__meta">${abertas.length} aberta(s) · ${items.length} no mês</p>
      </div>` +
      htmlBlocoAcerto({
        titulo: "Acerto entre nós",
        meta: "Pendências abertas com data neste mês.",
        saldos,
        transfers,
        vazio: !abertas.length,
        mostrarCabecalho: false,
      });

    $("#pendencias-rel-count").textContent = String(items.length);
    const lista = $("#lista-rel-pendencias");
    const empty = $("#empty-rel-pendencias");
    if (!items.length) {
      lista.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    lista.innerHTML = items
      .map((p) => {
        const status = p.status === "pago" ? "Pago" : "Pendente";
        return `
      <article class="mercado-item">
        <div>
          <p class="mercado-item__meta">${formatDate(p.data)} · ${status}</p>
          <p class="mercado-item__detalhe">${escapeHtml(p.descricao)}</p>
          <p class="mercado-item__por" style="margin-top:0.25rem">${escapeHtml(p.devedorNome)} → ${escapeHtml(p.credorNome)}</p>
        </div>
        <p class="mercado-item__valor">${formatMoney(p.valor)}</p>
      </article>`;
      })
      .join("");
  }

  /* ---------- PWA ---------- */
  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function updateInstallHint() {
    const hint = $("#install-hint");
    const btnLogin = $("#btn-install-login");
    const btnHeader = $("#btn-install");
    if (!hint) return;

    if (isStandalone()) {
      hint.textContent = "App já instalado neste aparelho.";
      btnLogin?.classList.add("hidden");
      btnHeader?.classList.add("hidden");
      return;
    }

    btnLogin?.classList.remove("hidden");
    btnHeader?.classList.remove("hidden");

    if (isIos()) {
      hint.textContent = "No iPhone/iPad: toque em Compartilhar → Adicionar à Tela de Início.";
    } else if (deferredInstallPrompt) {
      hint.textContent = "Toque em Instalar para adicionar à tela inicial.";
    } else {
      hint.textContent =
        "No Chrome/Edge: menu ⋮ → Instalar app (ou ícone de instalação na barra).";
    }
  }

  async function tryInstall() {
    if (isStandalone()) {
      toast("App já está instalado.");
      return;
    }
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      updateInstallHint();
      if (choice.outcome === "accepted") toast("App instalado!");
      return;
    }
    if (isIos()) {
      toast("No iOS: Compartilhar → Adicionar à Tela de Início.");
      return;
    }
    toast("Use o menu do navegador: Instalar app / Adicionar à tela inicial.");
  }

  function initPWA() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker
          .register("./sw.js", { scope: "./" })
          .then((reg) => {
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
          })
          .catch((err) => console.warn("SW:", err));
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
      updateInstallHint();
    });

    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      updateInstallHint();
      toast("App instalado!");
    });

    $("#btn-install")?.addEventListener("click", tryInstall);
    $("#btn-install-login")?.addEventListener("click", tryInstall);
    updateInstallHint();
  }

  function init() {
    if (normalizarPendenciasIds()) saveState();
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
