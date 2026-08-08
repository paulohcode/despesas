(() => {
  "use strict";

  const STORAGE_KEY = "despesas_domesticas_v1";
  const BACKUP_KEY = "despesas_domesticas_backup_v1";
  const SESSION_KEY = "despesas_usuario_atual";
  const REMEMBER_KEY = "despesas_manter_conectado";
  const CASA_KEY = "despesas_codigo_casa";
  const CASA_PADRAO = "familia-silva";
  const ADMIN_NOME = "paulo";
  const APP_BUILD = "v64";
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
  const DEFAULT_PESSOAL_TIPOS_RECEITA = [
    "Salário",
    "Benefício",
    "Vale-refeição / VR",
    "Vale-alimentação / VA",
    "Freelance",
    "Extra",
    "Outro",
  ];
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
  let usuarioAtualId = lerSessaoUsuarioId();
  let codigoCasa = localStorage.getItem(CASA_KEY) || CASA_PADRAO;
  let mesSelecionado = state.mesAtual || state.meses[0]?.id || null;
  let relatorioModo = "casa"; // casa | vaquinha | pendencias
  let pessoalDonoId = null;
  let pessoalMesId = todayISO().slice(0, 7);
  let pessoalBusca = "";
  let pessoalFiltroTipo = "todos"; // todos | despesas | receitas | fixas
  let pessoalFiltroCategoria = ""; // nome da categoria ou ""
  let editingMercadoId = null;
  let editingDespesaId = null;
  let editingVaquinhaId = null;
  let editingPessoalId = null;
  let editingReceitaId = null;
  let editingFixaId = null;
  let deferredInstallPrompt = null;
  let toastTimer = null;
  let syncRef = null;
  let syncUnsub = null;
  let applyingRemote = false;
  let pushTimer = null;
  let lastRemoteUpdatedAt = 0;
  let syncStatus = "offline"; // offline | syncing | online | error | local
  let ignoreRemoteUntil = 0; // evita eco da nuvem sobrescrever save local recente
  const pendingComprovante = { mercado: null, despesa: null, pessoal: null, vaquinha: null }; // Blob|null
  const comprovanteExistente = { mercado: null, despesa: null, pessoal: null, vaquinha: null }; // {url,path,data}|null when editing
  const comprovanteRemovido = { mercado: false, despesa: false, pessoal: false, vaquinha: false };
  let modalComprovanteCtx = null; // { id, kind, canRemove }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function lerSessaoUsuarioId() {
    try {
      const remember = localStorage.getItem(REMEMBER_KEY);
      if (remember === "1") {
        return localStorage.getItem(SESSION_KEY) || null;
      }
      if (remember === "0") {
        return sessionStorage.getItem(SESSION_KEY) || null;
      }
      // Sessão antiga (antes da opção “manter conectado”)
      const legacy = localStorage.getItem(SESSION_KEY);
      if (legacy) {
        localStorage.setItem(REMEMBER_KEY, "1");
        return legacy;
      }
      return sessionStorage.getItem(SESSION_KEY) || null;
    } catch {
      return null;
    }
  }

  function manterConectadoMarcado() {
    const el = $("#login-manter-conectado");
    return el ? !!el.checked : true;
  }

  function persistirSessao(pessoaId, manterConectado) {
    try {
      if (manterConectado) {
        localStorage.setItem(SESSION_KEY, pessoaId);
        localStorage.setItem(REMEMBER_KEY, "1");
        sessionStorage.removeItem(SESSION_KEY);
      } else {
        localStorage.removeItem(SESSION_KEY);
        localStorage.setItem(REMEMBER_KEY, "0");
        sessionStorage.setItem(SESSION_KEY, pessoaId);
      }
    } catch (err) {
      console.warn(err);
    }
  }

  function limparSessaoPersistida() {
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(REMEMBER_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    } catch (_) {
      /* ignore */
    }
  }

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
        pessoalReceitas: Array.isArray(parsed.pessoalReceitas) ? parsed.pessoalReceitas : [],
        pessoalAcessos: Array.isArray(parsed.pessoalAcessos) ? parsed.pessoalAcessos : [],
        pessoalTipos: Array.isArray(parsed.pessoalTipos) ? parsed.pessoalTipos : [],
        pessoalTiposReceita: Array.isArray(parsed.pessoalTiposReceita) ? parsed.pessoalTiposReceita : [],
        pessoalCategorias: Array.isArray(parsed.pessoalCategorias) ? parsed.pessoalCategorias : [],
        pessoalPagamentos: Array.isArray(parsed.pessoalPagamentos) ? parsed.pessoalPagamentos : [],
        pessoalDespesasFixas: Array.isArray(parsed.pessoalDespesasFixas)
          ? parsed.pessoalDespesasFixas
          : [],
        encontrosQuitacoes: Array.isArray(parsed.encontrosQuitacoes)
          ? parsed.encontrosQuitacoes
          : [],
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
      pessoalReceitas: [],
      pessoalAcessos: [],
      pessoalTipos: [],
      pessoalTiposReceita: [],
      pessoalCategorias: [],
      pessoalPagamentos: [],
      pessoalDespesasFixas: [],
      encontrosQuitacoes: [],
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
    // Janela curta: listener da nuvem não deve reaplicar versão antiga
    ignoreRemoteUntil = Date.now() + 2500;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    salvarBackupLocal("save");
    if (!applyingRemote) schedulePush();
  }

  function asArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.filter((x) => x != null);
    if (typeof val === "object") {
      return Object.keys(val)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => val[k])
        .filter((x) => x != null && typeof x === "object");
    }
    return [];
  }

  /** Remove base64 do payload da nuvem (sempre). Mantém só URL ImgBB. */
  function enxugarItemComprovante(item) {
    if (!item || typeof item !== "object") return item;
    const temDataCompra =
      Array.isArray(item.compras) && item.compras.some((c) => c && c.comprovanteData);
    if (!item.comprovanteData && !item.comprovantePagamentoData && !temDataCompra) return item;
    const copy = { ...item };
    delete copy.comprovanteData;
    delete copy.comprovantePagamentoData;
    if (Array.isArray(copy.compras)) {
      copy.compras = copy.compras.map((c) => {
        if (!c || !c.comprovanteData) return c;
        const cc = { ...c };
        delete cc.comprovanteData;
        return cc;
      });
    }
    return copy;
  }

  function enxugarLista(lista) {
    return asArray(lista).map(enxugarItemComprovante);
  }

  function normalizarPayloadRemoto(payload) {
    if (!payload || typeof payload !== "object") return null;
    return {
      ...payload,
      updatedAt: Number(payload.updatedAt) || 0,
      lancamentos: enxugarLista(payload.lancamentos),
      grupos: asArray(payload.grupos),
      meses: asArray(payload.meses),
      pessoas: asArray(payload.pessoas),
      tiposDespesa: asArray(payload.tiposDespesa),
      pendencias: asArray(payload.pendencias),
      pessoais: enxugarLista(payload.pessoais),
      pessoalReceitas: asArray(payload.pessoalReceitas),
      pessoalAcessos: asArray(payload.pessoalAcessos),
      pessoalTipos: asArray(payload.pessoalTipos),
      pessoalTiposReceita: asArray(payload.pessoalTiposReceita),
      pessoalCategorias: asArray(payload.pessoalCategorias),
      pessoalPagamentos: asArray(payload.pessoalPagamentos),
      pessoalDespesasFixas: asArray(payload.pessoalDespesasFixas),
      encontrosQuitacoes: asArray(payload.encontrosQuitacoes),
      notificacoes: asArray(payload.notificacoes),
    };
  }

  function scoreEstado(s) {
    if (!s || typeof s !== "object") return 0;
    const meses = asArray(s.meses);
    return (
      asArray(s.lancamentos).length * 6 +
      asArray(s.pendencias).length * 2 +
      asArray(s.pessoais).length * 2 +
      asArray(s.pessoalReceitas).length * 2 +
      asArray(s.pessoalDespesasFixas).length +
      asArray(s.encontrosQuitacoes).length +
      meses.length * 3 +
      meses.filter((m) => m && m.status === "fechado").length * 5 +
      asArray(s.pessoas).length +
      (s.mesAtual ? 2 : 0)
    );
  }

  function salvarBackupLocal(motivo) {
    try {
      const score = scoreEstado(state);
      if (score < 1 && !(Array.isArray(state.pessoas) && state.pessoas.length)) return;
      let prev = null;
      try {
        prev = JSON.parse(localStorage.getItem(BACKUP_KEY) || "null");
      } catch {
        prev = null;
      }
      const prevAt = Number(prev?.state?.updatedAt) || 0;
      const curAt = Number(state.updatedAt) || 0;
      // Só recusa backup se o anterior for MAIS NOVO (não se tiver mais itens)
      if (prev?.state && prevAt > curAt) return;
      localStorage.setItem(
        BACKUP_KEY,
        JSON.stringify({
          salvoEm: new Date().toISOString(),
          motivo: motivo || "auto",
          state: payloadFromState(),
        })
      );
    } catch (err) {
      console.warn("backup local:", err);
    }
  }

  function lerBackupLocal() {
    try {
      const raw = localStorage.getItem(BACKUP_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.state) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Decisão de sync: updatedAt mais novo vence (permite exclusões).
   * Score só serve de proteção anti-wipe (nuvem/local vazio vs dados reais).
   */
  function devePreferirRemoto(local, remote) {
    if (!remote) return false;
    const rScore = scoreEstado(remote);
    const lScore = scoreEstado(local);
    const rAt = Number(remote.updatedAt) || 0;
    const lAt = Number(local?.updatedAt) || 0;

    // Local sem dados → aceitar nuvem
    if (rScore > 0 && lScore === 0) return true;

    // Anti-wipe: nuvem praticamente vazia não apaga local rico/mais novo
    if (lScore >= 8 && rScore < 5 && lAt >= rAt) return false;

    // Quem salvou por último vence (inclusões e exclusões)
    if (rAt > lAt) return true;
    if (rAt < lAt) return false;

    // Empate de tempo: desempate por score
    return rScore > lScore;
  }

  function podeEnviarParaNuvem(local, remote) {
    if (!remote) return scoreEstado(local) > 0 || (Array.isArray(local.pessoas) && local.pessoas.length > 0);
    const lScore = scoreEstado(local);
    const rScore = scoreEstado(remote);
    const lAt = Number(local?.updatedAt) || 0;
    const rAt = Number(remote?.updatedAt) || 0;

    // Nunca enviar wipe em cima de nuvem com dados
    if (lScore === 0 && rScore > 0) return false;
    if (lScore < 5 && rScore >= 8 && lAt < rAt) return false;

    // Local mais novo → enviar (mesmo com menos itens = exclusão legítima)
    if (lAt > rAt) return true;
    if (lAt === rAt && lScore >= rScore) return true;
    return false;
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
    if (cfgStatus) {
      cfgStatus.textContent = detalhe
        ? `${text} — ${detalhe} (${APP_BUILD})`
        : `${text} (${APP_BUILD})`;
    }
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
      lancamentos: enxugarLista(state.lancamentos),
      grupos: asArray(state.grupos),
      pesos: pesosFromGrupos(state.grupos),
      meses: asArray(state.meses),
      mesAtual: state.mesAtual,
      pessoas: asArray(state.pessoas),
      tiposDespesa: asArray(state.tiposDespesa),
      pendencias: asArray(state.pendencias),
      pessoais: enxugarLista(state.pessoais),
      pessoalReceitas: asArray(state.pessoalReceitas),
      pessoalAcessos: asArray(state.pessoalAcessos),
      pessoalTipos: asArray(state.pessoalTipos),
      pessoalTiposReceita: asArray(state.pessoalTiposReceita),
      pessoalCategorias: asArray(state.pessoalCategorias),
      pessoalPagamentos: asArray(state.pessoalPagamentos),
      pessoalDespesasFixas: asArray(state.pessoalDespesasFixas),
      encontrosQuitacoes: asArray(state.encontrosQuitacoes),
      notificacoes: asArray(state.notificacoes).slice(0, 120),
    };
  }

  function applyRemotePayload(payload) {
    payload = normalizarPayloadRemoto(payload);
    if (!payload) return;
    const remoteAt = Number(payload.updatedAt) || 0;
    const localAt = Number(state.updatedAt) || 0;

    // Local igual ou mais novo: não sobrescrever (protege exclusão/adição recente)
    if (remoteAt && remoteAt <= localAt) {
      return;
    }
    if (remoteAt && remoteAt <= lastRemoteUpdatedAt) {
      return;
    }
    // Durante janela pós-save, só aceita remoto claramente mais novo
    if (Date.now() < ignoreRemoteUntil && remoteAt <= localAt) {
      return;
    }

    if (!devePreferirRemoto(state, payload)) {
      if (podeEnviarParaNuvem(state, payload)) schedulePush();
      return;
    }

    const notifsAntes = new Set(
      (usuarioAtualId ? state.notificacoes || [] : [])
        .filter((n) => n.paraUserId === usuarioAtualId)
        .map((n) => n.id)
    );

    salvarBackupLocal("antes-remoto");

    applyingRemote = true;
    try {
      const grupos = normalizarGrupos(payload.grupos, payload.pesos);
      state = {
        lancamentos: asArray(payload.lancamentos),
        grupos,
        pesos: pesosFromGrupos(grupos),
        meses: asArray(payload.meses),
        mesAtual: payload.mesAtual || null,
        pessoas: asArray(payload.pessoas),
        tiposDespesa: normalizarTiposDespesa(payload.tiposDespesa),
        pendencias: asArray(payload.pendencias),
        pessoais: asArray(payload.pessoais),
        pessoalReceitas: asArray(payload.pessoalReceitas),
        pessoalAcessos: asArray(payload.pessoalAcessos),
        pessoalTipos: asArray(payload.pessoalTipos),
        pessoalTiposReceita: asArray(payload.pessoalTiposReceita),
        pessoalCategorias: asArray(payload.pessoalCategorias),
        pessoalPagamentos: asArray(payload.pessoalPagamentos),
        pessoalDespesasFixas: asArray(payload.pessoalDespesasFixas),
        encontrosQuitacoes: asArray(payload.encontrosQuitacoes),
        notificacoes: asArray(payload.notificacoes),
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

      // Aviso nativo quando chegam notificações novas (mesmo em 2º plano)
      if (usuarioAtualId && notificacoesHabilitadas()) {
        const novas = (state.notificacoes || [])
          .filter((n) => n.paraUserId === usuarioAtualId && !notifsAntes.has(n.id) && !n.lida)
          .slice(0, 3);
        novas.forEach((n) => {
          if (jaViuPush(n.id)) return;
          marcarPushVisto(n.id);
          mostrarNotificacaoSistema(n.titulo, n.texto, n.id);
        });
      }

      if (usuarioAtual() && !$("#app").classList.contains("hidden")) {
        try {
          const eu = usuarioAtual();
          if (eu && pessoaPrecisaDefinirSenha(eu)) {
            forcarTelaLoginParaDefinirSenha(eu);
            return;
          }
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
        } catch (err) {
          console.warn("Falha ao atualizar UI após sync:", err);
        }
      } else {
        renderLoginUI();
      }
    } finally {
      applyingRemote = false;
    }
  }

  function schedulePush() {
    if (!firebasePronto() || !codigoCasa || !navigator.onLine) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushToCloud(), 200);
  }

  function arquivarBackupNuvem(payload) {
    if (!firebasePronto() || !codigoCasa || !navigator.onLine) return;
    if (scoreEstado(payload) < 8) return;
    try {
      const backupsRef = firebase.database().ref(`casas/${codigoCasa}/backups`);
      const id = String(payload.updatedAt || Date.now());
      backupsRef.child(id).set({
        ...payload,
        _backupEm: Date.now(),
      });
      backupsRef
        .once("value")
        .then((snap) => {
          const all = snap.val() || {};
          const ids = Object.keys(all).sort((a, b) => Number(b) - Number(a));
          if (ids.length <= 12) return;
          const removals = ids.slice(12).map((key) => backupsRef.child(key).remove());
          return Promise.all(removals);
        })
        .catch((err) => console.warn("prune backups:", err));
    } catch (err) {
      console.warn("backup nuvem:", err);
    }
  }

  async function buscarMelhorBackupNuvem() {
    if (!firebasePronto() || !codigoCasa) return null;
    try {
      const snap = await firebase.database().ref(`casas/${codigoCasa}/backups`).once("value");
      const all = snap.val();
      if (!all) return null;
      let best = null;
      Object.values(all).forEach((b) => {
        if (!b || typeof b !== "object") return;
        const bAt = Number(b.updatedAt) || 0;
        const bestAt = Number(best?.updatedAt) || 0;
        if (!best || bAt > bestAt || (bAt === bestAt && scoreEstado(b) > scoreEstado(best))) {
          best = b;
        }
      });
      return best;
    } catch (err) {
      console.warn("buscar backup nuvem:", err);
      return null;
    }
  }

  function pushToCloud() {
    if (!syncRef || applyingRemote || !navigator.onLine) return Promise.resolve();
    setSyncStatus("syncing", "Enviando alterações…");
    const payload = payloadFromState();
    salvarBackupLocal("antes-push");

    // Compara só updatedAt (leve) e faz set direto — transaction em ~1,5MB falhava e a exclusão não ia pra nuvem
    return syncRef
      .child("updatedAt")
      .once("value")
      .then((atSnap) => {
        const rAt = Number(atSnap.val()) || 0;
        const lAt = Number(payload.updatedAt) || 0;
        if (rAt > lAt) {
          return syncRef.once("value").then((full) => {
            const remoteNow = normalizarPayloadRemoto(full.val());
            if (remoteNow && devePreferirRemoto(state, remoteNow)) {
              applyRemotePayload(remoteNow);
              setSyncStatus("online", "Nuvem tinha versão mais nova");
            } else {
              setSyncStatus("online", "Sincronizado");
            }
          });
        }
        return syncRef.set(payload).then(() => {
          lastRemoteUpdatedAt = lAt;
          ignoreRemoteUntil = Date.now() + 1500;
          arquivarBackupNuvem(payload);
          setSyncStatus("online", "Dados sincronizados");
        });
      })
      .catch((err) => {
        console.error("pushToCloud:", err);
        // Segunda tentativa: payload mínimo (sem notificações longas)
        const leve = { ...payloadFromState(), notificacoes: [] };
        return syncRef
          .set(leve)
          .then(() => {
            lastRemoteUpdatedAt = Number(leve.updatedAt) || Date.now();
            setSyncStatus("online", "Dados sincronizados (compacto)");
          })
          .catch((err2) => {
            console.error("pushToCloud retry:", err2);
            setSyncStatus("error", err2.message || err.message || "Falha ao enviar");
            toast("Falha ao salvar na nuvem. Atualize o app (Config deve mostrar v56).");
          });
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
        .then(async (snap) => {
          let remote = normalizarPayloadRemoto(snap.val());

          // Se a nuvem principal está pobre/vazia, tenta o backup mais recente
          if (!remote || scoreEstado(remote) < 5) {
            const backup = await buscarMelhorBackupNuvem();
            const remoteAtBoot = Number(remote?.updatedAt) || 0;
            const backupAtBoot = Number(backup?.updatedAt) || 0;
            if (
              backup &&
              scoreEstado(backup) > scoreEstado(remote || {}) &&
              backupAtBoot >= remoteAtBoot
            ) {
              remote = backup;
              toast("Recuperado backup automático da nuvem.");
            }
          }

          // Backup local só restaura se for mais novo que o estado atual e a nuvem
          const localBackup = lerBackupLocal();
          const backupAt = Number(localBackup?.state?.updatedAt) || 0;
          const stateAt = Number(state.updatedAt) || 0;
          const remoteAt0 = Number(remote?.updatedAt) || 0;
          if (
            localBackup?.state &&
            backupAt > stateAt &&
            backupAt > remoteAt0 &&
            scoreEstado(localBackup.state) > 0
          ) {
            applyingRemote = true;
            try {
              state = { ...localBackup.state, updatedAt: backupAt };
              localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            } finally {
              applyingRemote = false;
            }
            toast("Restaurado backup local mais recente.");
            return pushToCloud();
          }

          if (remote && (remote.updatedAt || scoreEstado(remote) > 0)) {
            if (devePreferirRemoto(state, remote)) {
              applyRemotePayload(remote);
            } else if (podeEnviarParaNuvem(state, remote)) {
              return pushToCloud();
            }
          } else if (scoreEstado(state) > 0 || (state.pessoas && state.pessoas.length)) {
            return pushToCloud();
          }
          // remoto vazio e local vazio: não faz nada
        })
        .then(() => {
          const handler = (snap) => {
            const remote = normalizarPayloadRemoto(snap.val());
            if (!remote) return;
            const remoteAt = Number(remote.updatedAt) || 0;
            const localAt = Number(state.updatedAt) || 0;
            if (remoteAt === localAt) return;
            if (remoteAt <= lastRemoteUpdatedAt) return;
            if (remoteAt <= localAt) {
              // Eco antigo ou versão velha — reenvia o local se for o caso
              if (podeEnviarParaNuvem(state, remote)) schedulePush();
              return;
            }
            if (!devePreferirRemoto(state, remote)) {
              if (podeEnviarParaNuvem(state, remote)) schedulePush();
              return;
            }
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

  /** Só dígitos — máscara trata como centavos (51991 → 519,91) */
  function digitsOnly(str) {
    return String(str ?? "").replace(/\D/g, "");
  }

  function formatMoneyDigits(digits) {
    let d = digitsOnly(digits);
    if (!d) return "";
    d = d.replace(/^0+(?=\d)/, "");
    if (!d) d = "0";
    if (d.length > 12) d = d.slice(0, 12);
    const padded = d.padStart(3, "0");
    const cents = padded.slice(-2);
    let ints = padded.slice(0, -2);
    ints = ints.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `${ints},${cents}`;
  }

  function parseMoneyInput(str) {
    if (str == null || str === "") return NaN;
    if (typeof str === "number") return str;
    const raw = String(str).trim();
    if (!raw) return NaN;
    if (raw.includes(",")) {
      const n = Number(raw.replace(/\./g, "").replace(",", "."));
      return Number.isFinite(n) ? n : NaN;
    }
    // número puro estilo "12.34" (edição antiga / type=number)
    if (/^\d+(\.\d+)?$/.test(raw)) {
      const n = Number(raw);
      return Number.isFinite(n) ? n : NaN;
    }
    const digits = digitsOnly(raw);
    if (!digits) return NaN;
    return Number(digits) / 100;
  }

  function setMoneyInput(sel, valor) {
    const el = typeof sel === "string" ? $(sel) : sel;
    if (!el) return;
    const n = Number(valor);
    if (!(n >= 0) || !Number.isFinite(n)) {
      el.value = "";
      return;
    }
    el.value = formatMoneyDigits(String(Math.round(n * 100)));
  }

  function bindMoneyInput(el) {
    if (!el || el.dataset.moneyBound === "1") return;
    el.dataset.moneyBound = "1";
    el.setAttribute("inputmode", "numeric");
    el.setAttribute("autocomplete", "off");
    el.addEventListener("input", () => {
      const startLen = el.value.length;
      const pos = el.selectionStart;
      const formatted = formatMoneyDigits(el.value);
      el.value = formatted;
      // cursor no fim (máscara de centavos)
      try {
        const end = formatted.length;
        el.setSelectionRange(end, end);
      } catch {
        /* ignore */
      }
      void startLen;
      void pos;
      el.dispatchEvent(new Event("moneychange", { bubbles: true }));
    });
    el.addEventListener("blur", () => {
      const digits = digitsOnly(el.value);
      el.value = digits ? formatMoneyDigits(digits) : "";
    });
    if (el.value && !String(el.value).includes(",")) {
      const n = Number(el.value);
      if (Number.isFinite(n) && n >= 0) setMoneyInput(el, n);
    }
  }

  function bindMoneyInputs(root = document) {
    const scope = root instanceof Element ? root : document;
    scope.querySelectorAll("input.input-money").forEach((el) => bindMoneyInput(el));
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

  function mesAnteriorId(mesId) {
    if (!mesId || !/^\d{4}-\d{2}$/.test(mesId)) return null;
    const [y, m] = mesId.split("-").map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function fingerprintTransferencia(mesId, escopo, deId, paraId, valor) {
    return `${mesId}|${escopo}|${deId}|${paraId}|${Number(valor).toFixed(2)}`;
  }

  function quitacaoExiste(mesId, escopo, t) {
    if (!mesId || !escopo || !t) return false;
    const fp = fingerprintTransferencia(mesId, escopo, t.deId, t.paraId, t.valor);
    return (state.encontrosQuitacoes || []).some(
      (q) =>
        fingerprintTransferencia(q.mesId, q.escopo, q.deId, q.paraId, q.valor) === fp
    );
  }

  async function copiarTexto(texto) {
    const str = String(texto || "");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(str);
        return true;
      }
    } catch {
      /* fallback abaixo */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = str;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function setEditModeButtons(salvarId, cancelarId, editando, labelSalvar, labelEditar) {
    const btnSalvar = $(salvarId);
    const btnCancelar = $(cancelarId);
    if (btnSalvar) btnSalvar.textContent = editando ? labelEditar : labelSalvar;
    btnCancelar?.classList.toggle("hidden", !editando);
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

  /** Admin vê tudo; demais só pendências em que entram como credor/devedor. */
  function pendenciasVisiveis(lista) {
    const items = Array.isArray(lista) ? lista : [];
    if (isAdmin()) return items;
    const u = usuarioAtual();
    if (!u) return [];
    return items.filter((p) => usuarioNaPendencia(p, u));
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

  function pessoaPrecisaDefinirSenha(pessoa) {
    if (!pessoa) return true;
    if (pessoa.precisaDefinirSenha === true) return true;
    return !pessoa.senhaHash || !pessoa.senhaSalt;
  }

  function novoSaltSenha() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function hashSenha(senha, salt) {
    if (!crypto?.subtle?.digest) {
      throw new Error("Este navegador/ambiente não permite criptografar senha. Abra o app em HTTPS.");
    }
    const enc = new TextEncoder();
    const data = enc.encode(`${salt}:${senha}`);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function definirSenhaPessoa(pessoa, senha) {
    const salt = novoSaltSenha();
    const hash = await hashSenha(senha, salt);
    pessoa.senhaSalt = salt;
    pessoa.senhaHash = hash;
    pessoa.precisaDefinirSenha = false;
    pessoa.senhaAtualizadaEm = new Date().toISOString();
  }

  async function senhaConfere(pessoa, senha) {
    if (!pessoa?.senhaHash || !pessoa?.senhaSalt) return false;
    const hash = await hashSenha(senha, pessoa.senhaSalt);
    return hash === pessoa.senhaHash;
  }

  function resetarSenhaPessoa(pessoa) {
    if (!pessoa) return;
    delete pessoa.senhaHash;
    delete pessoa.senhaSalt;
    pessoa.precisaDefinirSenha = true;
    pessoa.senhaResetEm = new Date().toISOString();
  }

  function limparCamposSenhaLogin() {
    ["#login-senha", "#login-senha-confirma"].forEach((s) => {
      const el = $(s);
      if (el) el.value = "";
    });
  }

  function atualizarCamposSenhaLogin() {
    const vazio = !state.pessoas.length;
    const campoSenha = $("#login-campo-senha");
    const campoConfirma = $("#login-campo-confirma");
    const hint = $("#login-definir-hint");
    const labelSenha = $("#login-senha-label");
    const inputSenha = $("#login-senha");
    const btn = $("#btn-login-entrar");

    // Sempre mostra usuário/senha na tela inicial (quando já há cadastros)
    campoSenha?.classList.remove("hidden");

    if (vazio) {
      campoConfirma?.classList.remove("hidden");
      hint?.classList.remove("hidden");
      if (hint) hint.textContent = "Defina a senha do admin neste primeiro acesso (mín. 4 caracteres).";
      if (labelSenha) labelSenha.textContent = "Nova senha";
      if (inputSenha) {
        inputSenha.placeholder = "Mínimo 4 caracteres";
        inputSenha.autocomplete = "new-password";
      }
      if (btn) btn.textContent = "Criar admin e entrar";
      return;
    }

    const id = $("#login-usuario")?.value || "";
    const pessoa = state.pessoas.find((p) => p.id === id);
    const definir = !!(pessoa && pessoaPrecisaDefinirSenha(pessoa));

    campoConfirma?.classList.toggle("hidden", !definir);
    hint?.classList.toggle("hidden", !definir);
    if (hint) {
      hint.textContent = pessoa?.precisaDefinirSenha
        ? "Sua senha foi resetada. Digite a nova senha e confirme."
        : "Primeiro acesso: digite a nova senha e confirme.";
    }
    if (labelSenha) labelSenha.textContent = definir ? "Nova senha" : "Senha";
    if (inputSenha) {
      inputSenha.placeholder = definir ? "Mínimo 4 caracteres" : "Sua senha";
      inputSenha.autocomplete = definir ? "new-password" : "current-password";
    }
    if (!definir) {
      const conf = $("#login-senha-confirma");
      if (conf) conf.value = "";
    }
    if (btn) {
      if (!pessoa) btn.textContent = "Entrar";
      else btn.textContent = definir ? "Salvar senha e entrar" : "Entrar";
    }
  }

  function validarNovaSenhaDigitada(novaEl, confEl) {
    const nova = (novaEl?.value || $("#login-senha")?.value || "").trim();
    const conf = (confEl?.value || $("#login-senha-confirma")?.value || "").trim();
    if (nova.length < 4) {
      toast("A senha deve ter pelo menos 4 caracteres.");
      return null;
    }
    if (nova !== conf) {
      toast("As senhas não coincidem.");
      return null;
    }
    return nova;
  }

  let definirSenhaCtxId = null;

  function abrirModalDefinirSenha(pessoaId) {
    const pessoa = state.pessoas.find((p) => p.id === pessoaId);
    if (!pessoa) return toast("Usuário não encontrado.");
    const souEu = pessoa.id === usuarioAtualId;
    if (!souEu && !isAdmin()) return toast("Sem permissão.");
    definirSenhaCtxId = pessoa.id;
    const titulo = $("#modal-definir-senha-titulo");
    const texto = $("#modal-definir-senha-texto");
    if (titulo) titulo.textContent = souEu ? "Definir minha senha" : `Definir senha — ${pessoa.nome}`;
    if (texto) {
      texto.textContent = souEu
        ? "Escolha uma senha com pelo menos 4 caracteres para proteger seu acesso."
        : `Defina uma senha inicial para ${pessoa.nome}. A pessoa poderá trocá-la depois.`;
    }
    const nova = $("#modal-senha-nova");
    const conf = $("#modal-senha-confirma");
    if (nova) nova.value = "";
    if (conf) conf.value = "";
    const modal = $("#modal-definir-senha");
    if (modal?.showModal) modal.showModal();
    else modal?.setAttribute("open", "");
    setTimeout(() => nova?.focus(), 50);
  }

  function fecharModalDefinirSenha() {
    definirSenhaCtxId = null;
    const modal = $("#modal-definir-senha");
    try {
      modal?.close?.();
    } catch (_) {
      modal?.removeAttribute("open");
    }
  }

  function forcarTelaLoginParaDefinirSenha(pessoa) {
    usuarioAtualId = null;
    limparSessaoPersistida();
    $("#app")?.classList.add("hidden");
    $("#tela-login")?.classList.remove("hidden");
    renderLoginUI();
    const sel = $("#login-usuario");
    if (sel && pessoa?.id) {
      sel.value = pessoa.id;
      limparCamposSenhaLogin();
      atualizarCamposSenhaLogin();
    }
    toast(
      pessoa?.nome
        ? `${pessoa.nome}, defina sua senha para continuar.`
        : "Defina sua senha para continuar."
    );
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

  /* ---------- Comprovantes (foto) ---------- */
  function storagePronto() {
    try {
      return !!(firebasePronto() && window.firebase?.storage);
    } catch {
      return false;
    }
  }

  function imgbbPronto() {
    const key = String(window.IMGBB_CONFIG?.apiKey || "").trim();
    return key.length > 10;
  }

  function imgbbApiKey() {
    return String(window.IMGBB_CONFIG?.apiKey || "").trim();
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Falha ao ler imagem"));
      reader.readAsDataURL(blob);
    });
  }

  async function compressImageFile(file, maxSide = 1280, quality = 0.72) {
    const drawToBlob = async (source, width, height) => {
      const scale = Math.min(1, maxSide / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas indisponível");
      ctx.drawImage(source, 0, 0, w, h);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Falha ao comprimir imagem"))),
          "image/jpeg",
          quality
        );
      });
      return blob;
    };

    // Caminho preferencial
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file);
        try {
          return await drawToBlob(bitmap, bitmap.width, bitmap.height);
        } finally {
          bitmap.close?.();
        }
      } catch (err) {
        console.warn("createImageBitmap falhou, tentando fallback:", err);
      }
    }

    // Fallback (alguns Androids / fotos da câmera)
    const dataUrl = await blobToDataURL(file);
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Não foi possível ler a foto"));
      el.src = dataUrl;
    });
    return drawToBlob(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
  }

  function criarInputFotoTemporario(usarCamera) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.setAttribute("accept", "image/*");
    if (usarCamera) {
      input.setAttribute("capture", "environment");
      input.capture = "environment";
    }
    // Não usar display:none — alguns celulares ignoram o change da câmera
    input.className = "file-input-visually-hidden";
    document.body.appendChild(input);
    return input;
  }

  function escolherOrigemEArquivo() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "foto-origem-overlay";
      overlay.innerHTML = `
        <div class="foto-origem-sheet" role="dialog" aria-label="Origem da foto">
          <p class="foto-origem-sheet__titulo">Como deseja anexar?</p>
          <button type="button" class="btn btn--secondary" data-origem="camera">📷 Câmera</button>
          <button type="button" class="btn btn--secondary" data-origem="galeria">🖼 Galeria</button>
          <button type="button" class="btn btn--ghost" data-origem="">Cancelar</button>
        </div>`;

      let settled = false;
      const finish = (file) => {
        if (settled) return;
        settled = true;
        overlay.remove();
        resolve(file || null);
      };

      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) finish(null);
      });

      overlay.querySelectorAll("[data-origem]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const origem = btn.dataset.origem || "";
          if (!origem) {
            finish(null);
            return;
          }
          // Abrir o seletor no MESMO toque (obrigatório no celular)
          const input = criarInputFotoTemporario(origem === "camera");
          const limparInput = () => {
            try {
              input.remove();
            } catch {
              /* ignore */
            }
          };
          input.addEventListener(
            "change",
            () => {
              const file = input.files?.[0] || null;
              limparInput();
              finish(file);
            },
            { once: true }
          );
          input.addEventListener(
            "cancel",
            () => {
              limparInput();
              finish(null);
            },
            { once: true }
          );
          // Se o celular não dispara "cancel" ao fechar a câmera
          const onFocusBack = () => {
            setTimeout(() => {
              if (settled) return;
              if (input.files?.length) return;
              limparInput();
              finish(null);
            }, 600);
          };
          setTimeout(() => {
            window.addEventListener("focus", onFocusBack, { once: true });
          }, 400);
          // Esconde o sheet mas mantém o fluxo; click no mesmo toque
          overlay.style.visibility = "hidden";
          input.click();
        });
      });

      document.body.appendChild(overlay);
    });
  }

  async function anexarComprovanteExistente(itemId, kind) {
    const item = resolverItemComprovante(itemId, kind);
    if (!item) return toast("Lançamento não encontrado.");
    if (kind === "pessoal") {
      if (!podeEditarPessoalDe(item.donoId)) return toast("Sem permissão.");
    } else {
      if (item.lancadoPorId !== usuarioAtualId) return toast("Só quem lançou pode anexar.");
      if (!mesEstaAberto(item.mesId)) return toast("Só é possível anexar no mês aberto.");
    }

    const file = await escolherOrigemEArquivo();
    if (!file) return toast("Nenhuma foto selecionada.");

    try {
      if (!imgbbPronto()) {
        return toast("Configure a chave ImgBB em js/firebase-config.js (veja api.imgbb.com).");
      }
      toast("Enviando foto…");
      const blob = await compressImageFile(file);
      const result = await uploadComprovante(blob, item.id);
      if (result.url) {
        item.comprovanteUrl = result.url;
        item.comprovantePath = result.path || "";
        item.comprovanteProvider = result.provider || "imgbb";
        delete item.comprovanteData;
      } else if (result.data) {
        item.comprovanteData = result.data;
        item.comprovanteProvider = "data";
        delete item.comprovanteUrl;
        delete item.comprovantePath;
      }
      saveState();
      if (kind === "pessoal") renderPessoal();
      else if (item.tipo === "mercado") renderMercadoLista();
      else if (item.tipo === "vaquinha") renderVaquinhaLista();
      else renderDespesaLista();
      toast("Foto anexada.");
    } catch (err) {
      console.warn(err);
      toast(err?.message || "Não foi possível anexar a foto.");
    }
  }

  function initComprovanteCampos() {
    ["mercado", "despesa", "pessoal", "vaquinha"].forEach((kind) => {
      const btnCam = $(`#${kind}-foto-camera`);
      const btnGal = $(`#${kind}-foto-galeria`);
      const fileCam = $(`#${kind}-foto-cam`);
      const fileGal = $(`#${kind}-foto`);
      const limpar = $(`#${kind}-foto-limpar`);

      // Troca .hidden (display:none) por classe que o celular aceita
      [fileCam, fileGal].forEach((el) => {
        if (!el) return;
        el.classList.remove("hidden");
        el.classList.add("file-input-visually-hidden");
      });

      const processarArquivo = async (fileEl) => {
        const chosen = fileEl.files?.[0];
        if (!chosen) {
          toast("Nenhuma foto recebida. Tente de novo ou use Galeria.");
          return;
        }
        try {
          toast("Processando foto…");
          const blob = await compressImageFile(chosen);
          pendingComprovante[kind] = blob;
          comprovanteRemovido[kind] = false;
          const previewUrl = URL.createObjectURL(blob);
          mostrarPreviewComprovante(kind, previewUrl);
          toast("Foto pronta. Salve o lançamento para enviar.");
        } catch (err) {
          console.warn(err);
          pendingComprovante[kind] = null;
          toast(err?.message || "Não foi possível processar a imagem.");
        } finally {
          try {
            fileEl.value = "";
          } catch {
            /* ignore */
          }
        }
      };

      btnCam?.addEventListener("click", (e) => {
        e.preventDefault();
        fileCam?.click();
      });
      btnGal?.addEventListener("click", (e) => {
        e.preventDefault();
        fileGal?.click();
      });
      fileCam?.addEventListener("change", () => processarArquivo(fileCam));
      fileGal?.addEventListener("change", () => processarArquivo(fileGal));
      limpar?.addEventListener("click", () => {
        limparComprovanteCampo(kind, { marcarRemovido: true });
        toast("Foto removida do formulário.");
      });
    });

    $("#btn-fechar-comprovante")?.addEventListener("click", () => {
      $("#modal-comprovante")?.close?.();
      modalComprovanteCtx = null;
    });
    $("#btn-excluir-comprovante")?.addEventListener("click", () => {
      if (!modalComprovanteCtx?.id) return;
      if (modalComprovanteCtx.kind === "vaquinha-pag") {
        removerComprovantePagamentoVaquinha(modalComprovanteCtx.id);
        return;
      }
      removerComprovanteDoItem(modalComprovanteCtx.id, modalComprovanteCtx.kind);
    });
  }

  async function uploadComprovanteImgBB(blob, itemId) {
    const key = imgbbApiKey();
    if (!key) throw new Error("Chave ImgBB não configurada.");
    if (!navigator.onLine) throw new Error("Sem internet para enviar a foto.");

    const form = new FormData();
    form.append("image", blob, `${itemId || "foto"}.jpg`);
    form.append("name", `despesa-${itemId || Date.now()}`);

    const res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`, {
      method: "POST",
      body: form,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success || !json?.data) {
      const msg =
        json?.error?.message ||
        json?.status_txt ||
        `ImgBB recusou o upload (HTTP ${res.status}).`;
      throw new Error(msg);
    }
    const url = json.data.display_url || json.data.url || json.data.image?.url;
    if (!url) throw new Error("ImgBB não retornou URL da imagem.");
    return {
      url,
      path: json.data.delete_url || "",
      provider: "imgbb",
    };
  }

  async function uploadComprovanteDataUrl(blob) {
    let dataUrl = await blobToDataURL(blob);
    if (dataUrl.length > 450_000) {
      const harder = await compressImageFile(blob, 960, 0.55);
      dataUrl = await blobToDataURL(harder);
    }
    if (dataUrl.length > 450_000) {
      const harder = await compressImageFile(blob, 720, 0.45);
      dataUrl = await blobToDataURL(harder);
    }
    if (dataUrl.length > 450_000) {
      throw new Error("Foto ainda grande demais para salvar sem ImgBB.");
    }
    return { data: dataUrl, provider: "data" };
  }

  async function uploadComprovante(blob, itemId) {
    // 1) ImgBB (principal — sem Blaze)
    if (imgbbPronto()) {
      try {
        return await uploadComprovanteImgBB(blob, itemId);
      } catch (err) {
        console.warn("Upload ImgBB falhou:", err);
        toast(`ImgBB: ${err?.message || "falha no envio"}. Tentando reserva…`);
      }
    } else {
      console.warn("IMGBB_CONFIG.apiKey vazia — configure em js/firebase-config.js");
    }

    // 2) Firebase Storage (só se ainda estiver liberado no projeto)
    const path = `casas/${codigoCasa}/comprovantes/${itemId}_${Date.now()}.jpg`;
    if (storagePronto() && navigator.onLine && codigoCasa) {
      try {
        if (!firebase.apps.length) {
          firebase.initializeApp(window.FIREBASE_CONFIG);
        }
        const ref = firebase.storage().ref(path);
        await ref.put(blob, { contentType: "image/jpeg" });
        const url = await ref.getDownloadURL();
        return { url, path, provider: "firebase" };
      } catch (err) {
        console.warn("Upload Storage falhou:", err);
      }
    }

    // 3) Último recurso: embutir no Database (pode falhar se o estado ficar grande)
    return uploadComprovanteDataUrl(blob);
  }

  function srcComprovante(item) {
    if (!item) return "";
    return item.comprovanteUrl || item.comprovanteData || "";
  }

  function srcComprovanteCompra(compra) {
    if (!compra) return "";
    return compra.comprovanteUrl || compra.comprovanteData || "";
  }

  function srcComprovantePagamento(item) {
    if (!item) return "";
    return item.comprovantePagamentoUrl || item.comprovantePagamentoData || "";
  }

  function vaquinhaEstaPaga(item) {
    if (!item || item.tipo !== "vaquinha") return false;
    const acerto = atribuirAcertoVaquinhasDoEncontro(item.mesId)?.[item.id];
    return !!acerto?.quitada;
  }

  function chaveParTransferencia(deId, paraId) {
    return `${deId || ""}→${paraId || ""}`;
  }

  /** Soma o que já foi marcado como pago no Encontro (por par de pessoas). */
  function poolQuitacoesEncontroMes(mesId) {
    const pool = {};
    (state.encontrosQuitacoes || []).forEach((q) => {
      if (!q || q.mesId !== mesId) return;
      if (q.escopo !== "encontro" && q.escopo !== "pessoas") return;
      const k = chaveParTransferencia(q.deId, q.paraId);
      pool[k] = (pool[k] || 0) + (Number(q.valor) || 0);
    });
    return pool;
  }

  function saldosInternosVaquinha(item) {
    const migrada = migrarVaquinha(item);
    const compras = Array.isArray(migrada.compras) ? migrada.compras : [];
    const base = (migrada.participantes || [])
      .map((p) => ({
        pessoaId: p.pessoaId,
        nome: p.nome,
        peso: Number(p.peso) || 1,
      }))
      .filter((p) => p.pessoaId);
    if (compras.length && base.length) {
      return calcularAcerto(compras, base).map((p) => ({
        id: p.pessoaId,
        nome: p.nome,
        saldo: Number(p.saldo) || 0,
        pagou: Number(p.pagou) || 0,
        cota: Number(p.cota) || 0,
      }));
    }
    return (migrada.participantes || [])
      .filter((p) => p?.pessoaId)
      .map((p) => ({
        id: p.pessoaId,
        nome: p.nome,
        saldo: Number(p.saldo) || 0,
        pagou: Number(p.pagou) || 0,
        cota: Number(p.cota) || 0,
      }));
  }

  /**
   * Cruza o acerto interno de cada vaquinha com as quitações do Encontro.
   * O pool de pagamentos do mês (por par) cobre as vaquinhas em ordem de data.
   */
  function atribuirAcertoVaquinhasDoEncontro(mesId) {
    const out = {};
    if (!mesId) return out;
    const pool = poolQuitacoesEncontroMes(mesId);
    const vaquinhas = state.lancamentos
      .filter((l) => l.tipo === "vaquinha" && l.mesId === mesId)
      .sort((a, b) => {
        const d = String(a.data || "").localeCompare(String(b.data || ""));
        if (d) return d;
        return String(a.criadoEm || "").localeCompare(String(b.criadoEm || ""));
      });

    vaquinhas.forEach((v) => {
      const transfers = calcularTransferencias(saldosInternosVaquinha(v));
      let pago = 0;
      let falta = 0;
      const linhas = transfers.map((t) => {
        const k = chaveParTransferencia(t.deId, t.paraId);
        const disponivel = pool[k] || 0;
        const valor = Number(t.valor) || 0;
        const pagoLinha = Math.min(valor, disponivel);
        pool[k] = disponivel - pagoLinha;
        const faltaLinha = valor - pagoLinha;
        pago += pagoLinha;
        falta += faltaLinha;
        return {
          ...t,
          pago: pagoLinha,
          falta: faltaLinha,
          quitado: faltaLinha < 0.005,
        };
      });
      const total = pago + falta;
      out[v.id] = {
        total,
        pago,
        falta,
        transfers: linhas,
        equilibrada: transfers.length === 0,
        quitada: transfers.length === 0 || (total > 0.005 && falta < 0.005),
      };
    });
    return out;
  }

  function htmlAcertoVaquinhaEncontro(acerto) {
    if (!acerto) return "";
    if (acerto.equilibrada) {
      return `<p class="vaquinha-acerto vaquinha-acerto--ok">Sem transferência interna — já equilibrada.</p>`;
    }
    const linhas = (acerto.transfers || [])
      .map((t) => {
        const st = t.quitado
          ? `<span class="badge badge--aberto">Pago no encontro</span>`
          : t.pago > 0.005
            ? `<span class="badge badge--fechado">Pago ${formatMoney(t.pago)} · falta ${formatMoney(t.falta)}</span>`
            : `<span class="badge badge--fechado">Falta ${formatMoney(t.falta)}</span>`;
        return `<div class="vaquinha-acerto__linha"><span>${escapeHtml(t.deNome)} → ${escapeHtml(
          t.paraNome
        )}: ${formatMoney(t.valor)}</span> ${st}</div>`;
      })
      .join("");
    const resumo = acerto.quitada
      ? `Quitada no encontro · ${formatMoney(acerto.pago)}`
      : `Pago no encontro ${formatMoney(acerto.pago)} · falta acertar ${formatMoney(acerto.falta)}`;
    return `
      <div class="vaquinha-acerto">
        <p class="vaquinha-acerto__titulo">${resumo}</p>
        ${linhas}
      </div>`;
  }

  function usuarioPodePagarVaquinha(item) {
    const u = usuarioAtual();
    if (!u || !item || item.tipo !== "vaquinha") return false;
    if (isAdmin()) return true;
    if (item.lancadoPorId === u.id) return true;
    return (item.participantes || []).some((p) => p.pessoaId === u.id);
  }

  function htmlBtnComprovantePagamento(item, opts = {}) {
    const canAdd = !!opts.canAdd;
    const canRemove = !!opts.canRemove;
    const compact = opts.compact !== false;
    const parts = [];
    if (srcComprovantePagamento(item)) {
      parts.push(
        `<button type="button" class="btn btn--secondary btn--sm btn-ver-comprovante-pag" data-id="${escapeHtml(
          item.id
        )}" data-can-remove="${canRemove ? "1" : "0"}" title="Ver comprovante de pagamento">${
          compact ? "💳" : "💳 Pag."
        }</button>`
      );
      if (canRemove) {
        parts.push(
          `<button type="button" class="btn btn--ghost btn--sm btn-excluir-foto-pag" data-id="${escapeHtml(
            item.id
          )}" title="Excluir comprovante de pagamento">${compact ? "🗑" : "🗑 Pag."}</button>`
        );
      }
    } else if (canAdd) {
      parts.push(
        `<button type="button" class="btn btn--secondary btn--sm btn-add-comprovante-pag" data-id="${escapeHtml(
          item.id
        )}" title="Anexar comprovante de pagamento">${compact ? "📷 Pag." : "📷 Comprovante pag."}</button>`
      );
    }
    return parts.join("");
  }

  function htmlBtnComprovante(item, opts = {}) {
    const kind = opts.kind || "lancamento";
    const canAdd = !!opts.canAdd;
    const canRemove = !!opts.canRemove;
    const compact = opts.compact !== false; // ícones na lista (economiza espaço)
    const parts = [];
    if (srcComprovante(item)) {
      parts.push(
        `<button type="button" class="btn btn--secondary btn--sm btn-ver-comprovante" data-id="${escapeHtml(
          item.id
        )}" data-kind="${escapeHtml(kind)}" data-can-remove="${canRemove ? "1" : "0"}" title="Ver comprovante">${
          compact ? "📄" : "📄 Ver"
        }</button>`
      );
      if (canRemove) {
        parts.push(
          `<button type="button" class="btn btn--ghost btn--sm btn-excluir-foto-comprovante" data-id="${escapeHtml(
            item.id
          )}" data-kind="${escapeHtml(kind)}" title="Excluir foto">${compact ? "🗑" : "🗑 Foto"}</button>`
        );
      }
    } else if (canAdd) {
      parts.push(
        `<button type="button" class="btn btn--secondary btn--sm btn--foto btn-add-comprovante" data-id="${escapeHtml(
          item.id
        )}" data-kind="${escapeHtml(kind)}" title="Anexar foto">📷</button>`
      );
    }
    return parts.join("");
  }

  function abrirComprovante(src, ctx = null) {
    if (!src) return;
    modalComprovanteCtx = ctx;
    const dialog = $("#modal-comprovante");
    const img = $("#modal-comprovante-img");
    const link = $("#modal-comprovante-abrir");
    const btnExcluir = $("#btn-excluir-comprovante");
    if (img) img.src = src;
    if (link) {
      link.href = src;
      link.classList.toggle("hidden", src.startsWith("data:"));
    }
    btnExcluir?.classList.toggle("hidden", !(ctx && ctx.canRemove && ctx.id));
    dialog?.showModal?.();
  }

  function podeRemoverComprovanteItem(item, kind) {
    if (!item || !srcComprovante(item)) return false;
    if (kind === "pessoal") return podeEditarPessoalDe(item.donoId);
    return (
      item.lancadoPorId === usuarioAtualId && mesEstaAberto(item.mesId)
    );
  }

  function removerComprovanteDoItem(itemId, kind) {
    const item = resolverItemComprovante(itemId, kind);
    if (!item) return toast("Lançamento não encontrado.");
    if (!podeRemoverComprovanteItem(item, kind)) {
      return toast("Sem permissão para excluir esta foto.");
    }
    if (!confirm("Excluir a foto do comprovante?\nVocê poderá tirar outra depois.")) return;

    excluirComprovanteRemoto(item);
    delete item.comprovanteUrl;
    delete item.comprovantePath;
    delete item.comprovanteData;
    delete item.comprovanteProvider;
    saveState();
    $("#modal-comprovante")?.close?.();
    modalComprovanteCtx = null;
    renderMercadoLista();
    renderDespesaLista();
    renderVaquinhaLista();
    renderPessoal();
    renderRelatorio();
    toast("Foto excluída. Use 📷 para tirar outra.");
  }

  function limparComprovanteCampo(kind, opts = {}) {
    const marcarRemovido = !!opts.marcarRemovido;
    pendingComprovante[kind] = null;
    comprovanteExistente[kind] = null;
    comprovanteRemovido[kind] = marcarRemovido;
    const file = $(`#${kind}-foto`);
    if (file) file.value = "";
    const preview = $(`#${kind}-foto-preview`);
    const img = preview?.querySelector("img");
    if (img) img.removeAttribute("src");
    preview?.classList.add("hidden");
    $(`#${kind}-foto-limpar`)?.classList.add("hidden");
  }

  function mostrarPreviewComprovante(kind, src) {
    const preview = $(`#${kind}-foto-preview`);
    const img = preview?.querySelector("img");
    if (!preview || !img || !src) return;
    img.src = src;
    preview.classList.remove("hidden");
    $(`#${kind}-foto-limpar`)?.classList.remove("hidden");
  }

  async function aplicarComprovanteNoItem(item, kind) {
    if (!item) return;
    if (pendingComprovante[kind]) {
      if (!imgbbPronto() && !storagePronto()) {
        toast("Configure a chave ImgBB em js/firebase-config.js para salvar fotos.");
      }
      toast("Enviando foto…");
      const oldPath = item.comprovantePath || null;
      const result = await uploadComprovante(pendingComprovante[kind], item.id);
      if (result.url) {
        item.comprovanteUrl = result.url;
        item.comprovantePath = result.path || "";
        item.comprovanteProvider = result.provider || "imgbb";
        delete item.comprovanteData;
      } else if (result.data) {
        item.comprovanteData = result.data;
        item.comprovanteProvider = "data";
        delete item.comprovanteUrl;
        delete item.comprovantePath;
      }
      if (oldPath && oldPath !== item.comprovantePath) {
        excluirComprovanteRemoto(oldPath);
      }
      return;
    }
    if (comprovanteRemovido[kind]) {
      excluirComprovanteRemoto(item);
      delete item.comprovanteUrl;
      delete item.comprovantePath;
      delete item.comprovanteData;
      delete item.comprovanteProvider;
      return;
    }
    // Mantém comprovanteExistente / campos já no item
  }

  function excluirComprovanteRemoto(itemOrPath) {
    const path =
      typeof itemOrPath === "string" ? itemOrPath : itemOrPath?.comprovantePath || "";
    if (!path) return;

    // ImgBB: delete_url (abre exclusão no site — best effort)
    if (/^https?:\/\//i.test(path)) {
      try {
        fetch(path, { method: "GET", mode: "no-cors" }).catch(() => {});
      } catch {
        /* ignore */
      }
      return;
    }

    // Firebase Storage legado
    if (!storagePronto()) return;
    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(window.FIREBASE_CONFIG);
      }
      firebase.storage().ref(path).delete().catch(() => {});
    } catch {
      /* best-effort */
    }
  }

  /** @deprecated use excluirComprovanteRemoto */
  function excluirComprovanteStorage(path) {
    excluirComprovanteRemoto(path);
  }

  function resolverItemComprovante(id, kind) {
    if (kind === "pessoal") {
      return (state.pessoais || []).find((p) => p.id === id) || null;
    }
    return state.lancamentos.find((l) => l.id === id) || null;
  }

  function wireComprovanteListEvents(root) {
    if (!root) return;
    root.querySelectorAll(".btn-ver-comprovante").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = resolverItemComprovante(btn.dataset.id, btn.dataset.kind);
        const src = srcComprovante(item);
        if (!src) return toast("Comprovante não encontrado.");
        const canRemove =
          btn.dataset.canRemove === "1" ||
          podeRemoverComprovanteItem(item, btn.dataset.kind);
        abrirComprovante(src, {
          id: btn.dataset.id,
          kind: btn.dataset.kind,
          canRemove,
        });
      });
    });
    root.querySelectorAll(".btn-excluir-foto-comprovante").forEach((btn) => {
      btn.addEventListener("click", () => {
        removerComprovanteDoItem(btn.dataset.id, btn.dataset.kind);
      });
    });
    root.querySelectorAll(".btn-add-comprovante").forEach((btn) => {
      btn.addEventListener("click", () => anexarComprovanteExistente(btn.dataset.id, btn.dataset.kind));
    });
    wireComprovantePagamentoEvents(root);
  }

  function wireComprovantePagamentoEvents(root) {
    if (!root) return;
    root.querySelectorAll(".btn-ver-comprovante-pag").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = state.lancamentos.find((l) => l.id === btn.dataset.id && l.tipo === "vaquinha");
        const src = srcComprovantePagamento(item);
        if (!src) return toast("Comprovante de pagamento não encontrado.");
        abrirComprovante(src, {
          id: btn.dataset.id,
          kind: "vaquinha-pag",
          canRemove: btn.dataset.canRemove === "1",
        });
      });
    });
    root.querySelectorAll(".btn-excluir-foto-pag").forEach((btn) => {
      btn.addEventListener("click", () => removerComprovantePagamentoVaquinha(btn.dataset.id));
    });
    root.querySelectorAll(".btn-add-comprovante-pag").forEach((btn) => {
      btn.addEventListener("click", () => anexarComprovantePagamentoVaquinha(btn.dataset.id));
    });
  }

  async function anexarComprovantePagamentoVaquinha(itemId) {
    const item = state.lancamentos.find((l) => l.id === itemId && l.tipo === "vaquinha");
    if (!item) return toast("Vaquinha não encontrada.");
    if (!usuarioPodePagarVaquinha(item)) return toast("Sem permissão.");
    if (!mesEstaAberto(item.mesId)) return toast("Só é possível anexar no mês aberto.");

    const file = await escolherOrigemEArquivo();
    if (!file) return toast("Nenhuma foto selecionada.");

    try {
      if (!imgbbPronto()) {
        return toast("Configure a chave ImgBB em js/firebase-config.js (veja api.imgbb.com).");
      }
      toast("Enviando comprovante de pagamento…");
      const blob = await compressImageFile(file);
      const oldPath = item.comprovantePagamentoPath || null;
      const result = await uploadComprovante(blob, `${item.id}-pag`);
      if (result.url) {
        item.comprovantePagamentoUrl = result.url;
        item.comprovantePagamentoPath = result.path || "";
        item.comprovantePagamentoProvider = result.provider || "imgbb";
        delete item.comprovantePagamentoData;
      } else if (result.data) {
        item.comprovantePagamentoData = result.data;
        item.comprovantePagamentoProvider = "data";
        delete item.comprovantePagamentoUrl;
        delete item.comprovantePagamentoPath;
      }
      if (oldPath && oldPath !== item.comprovantePagamentoPath) {
        excluirComprovanteRemoto(oldPath);
      }
      saveState();
      renderVaquinhaLista();
      renderRelatorio();
      toast("Comprovante de pagamento anexado.");
    } catch (err) {
      console.warn(err);
      toast(err?.message || "Não foi possível anexar a foto.");
    }
  }

  function removerComprovantePagamentoVaquinha(itemId) {
    const item = state.lancamentos.find((l) => l.id === itemId && l.tipo === "vaquinha");
    if (!item) return toast("Vaquinha não encontrada.");
    if (!usuarioPodePagarVaquinha(item) || !mesEstaAberto(item.mesId)) {
      return toast("Sem permissão para excluir esta foto.");
    }
    if (!srcComprovantePagamento(item)) return;
    if (!confirm("Excluir o comprovante de pagamento?\nVocê poderá anexar outro depois.")) return;

    if (item.comprovantePagamentoPath) excluirComprovanteRemoto(item.comprovantePagamentoPath);
    delete item.comprovantePagamentoUrl;
    delete item.comprovantePagamentoPath;
    delete item.comprovantePagamentoData;
    delete item.comprovantePagamentoProvider;
    saveState();
    $("#modal-comprovante")?.close?.();
    modalComprovanteCtx = null;
    renderVaquinhaLista();
    renderRelatorio();
    toast("Comprovante de pagamento excluído.");
  }

  /* ---------- Notificações ---------- */
  const PUSH_SEEN_KEY = "despesas_push_seen_v1";
  const PUSH_PROMPT_DISMISS_KEY = "despesas_push_prompt_dismiss_v1";
  let pushBuildRequest = null;

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const output = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i += 1) output[i] = rawData.charCodeAt(i);
    return output;
  }

  function jaViuPush(id) {
    try {
      const arr = JSON.parse(sessionStorage.getItem(PUSH_SEEN_KEY) || "[]");
      return arr.includes(id);
    } catch {
      return false;
    }
  }

  function marcarPushVisto(id) {
    try {
      const arr = JSON.parse(sessionStorage.getItem(PUSH_SEEN_KEY) || "[]");
      arr.push(id);
      sessionStorage.setItem(PUSH_SEEN_KEY, JSON.stringify(arr.slice(-80)));
    } catch {
      /* ignore */
    }
  }

  function notificacoesHabilitadas() {
    return "Notification" in window && Notification.permission === "granted";
  }

  function pushSuportado() {
    return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
  }

  function pushPromptDispensado() {
    try {
      const until = Number(localStorage.getItem(PUSH_PROMPT_DISMISS_KEY) || 0);
      return until > Date.now();
    } catch {
      return false;
    }
  }

  function dispensarPushPrompt(dias = 3) {
    try {
      localStorage.setItem(PUSH_PROMPT_DISMISS_KEY, String(Date.now() + dias * 24 * 60 * 60 * 1000));
    } catch {
      /* ignore */
    }
    atualizarBannerPush();
  }

  function limparDismissPushPrompt() {
    try {
      localStorage.removeItem(PUSH_PROMPT_DISMISS_KEY);
    } catch {
      /* ignore */
    }
  }

  function irParaConfig() {
    $$(".nav__btn").find((b) => b.dataset.tab === "config")?.click();
    setTimeout(() => {
      $("#btn-ativar-push")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
  }

  function fecharModalAtivarPush() {
    const dlg = $("#modal-ativar-push");
    if (dlg?.open) dlg.close();
  }

  function textoModalPush() {
    if (!pushSuportado()) {
      return "Este navegador não suporta notificações push. No iPhone, adicione o app à Tela de Início (iOS 16.4+).";
    }
    if (Notification.permission === "denied") {
      return "As notificações estão bloqueadas. Abra as configurações do celular/navegador, permita notificações para este app e toque em Ativar de novo.";
    }
    return "Ative para receber avisos de novos lançamentos, vaquinhas e pendências mesmo com o app fechado.";
  }

  function mostrarModalAtivarPush() {
    const dlg = $("#modal-ativar-push");
    if (!dlg) return;
    const txt = $("#modal-ativar-push-texto");
    if (txt) txt.textContent = textoModalPush();
    const btnAtivar = $("#btn-modal-push-ativar");
    if (btnAtivar) {
      btnAtivar.textContent =
        Notification.permission === "denied" ? "Já liberei — tentar de novo" : "Ativar agora";
    }
    if (!dlg.open) dlg.showModal();
  }

  function atualizarBannerPush() {
    const banner = $("#banner-push");
    if (!banner) return;
    const mostrar =
      !!usuarioAtualId &&
      pushSuportado() &&
      Notification.permission !== "granted" &&
      !pushPromptDispensado();
    banner.classList.toggle("hidden", !mostrar);
  }

  function talvezPedirNotificacoes() {
    if (!usuarioAtualId || !pushSuportado()) {
      atualizarBannerPush();
      return;
    }
    if (Notification.permission === "granted") {
      limparDismissPushPrompt();
      atualizarBannerPush();
      return;
    }
    atualizarBannerPush();
    if (pushPromptDispensado()) return;
    setTimeout(() => {
      if (!usuarioAtualId || notificacoesHabilitadas() || pushPromptDispensado()) return;
      mostrarModalAtivarPush();
    }, 900);
  }

  function atualizarPushStatus() {
    const el = $("#push-status");
    if (el) {
      if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        el.textContent = "Não suportado neste navegador";
      } else if (Notification.permission === "granted") el.textContent = "Ativado";
      else if (Notification.permission === "denied") el.textContent = "Bloqueado nas configurações do celular";
      else el.textContent = "Desativado";
    }
    atualizarBannerPush();
  }

  async function mostrarNotificacaoSistema(titulo, texto, tag) {
    if (!notificacoesHabilitadas()) return;
    const t = String(titulo || "Despesas").slice(0, 80);
    const b = String(texto || "").slice(0, 180);
    const idTag = tag || `despesas-${Date.now()}`;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg && reg.showNotification) {
        await reg.showNotification(t, {
          body: b,
          icon: "./icons/icon-192.png",
          badge: "./icons/icon-192.png",
          tag: idTag,
          renotify: true,
          data: { url: "./index.html" },
        });
        return;
      }
    } catch (err) {
      console.warn("SW notification:", err);
    }
    try {
      new Notification(t, { body: b, tag: idTag });
    } catch (err) {
      console.warn("Notification:", err);
    }
  }

  async function salvarInscricaoPush(sub) {
    if (!firebasePronto() || !codigoCasa || !usuarioAtualId || !sub) return;
    try {
      await firebase
        .database()
        .ref(`casas/${codigoCasa}/webpush/${usuarioAtualId}`)
        .set({
          subscription: sub.toJSON(),
          userId: usuarioAtualId,
          nome: usuarioAtual()?.nome || "",
          updatedAt: Date.now(),
        });
    } catch (err) {
      console.warn("salvar push:", err);
    }
  }

  async function ativarNotificacoesPush() {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      toast("Este navegador não suporta notificações push.");
      atualizarPushStatus();
      return false;
    }

    if (Notification.permission === "denied") {
      atualizarPushStatus();
      mostrarModalAtivarPush();
      toast("Permissão bloqueada. Libere nas configurações do celular e tente de novo.");
      return false;
    }

    const perm = await Notification.requestPermission();
    atualizarPushStatus();
    if (perm !== "granted") {
      toast("Permissão negada. Libere nas configurações do navegador/app.");
      atualizarBannerPush();
      return false;
    }

    const vapid = window.VAPID_CONFIG;
    if (!vapid?.publicKey) {
      toast("VAPID não configurado.");
      return false;
    }

    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapid.publicKey),
        });
      }
      await salvarInscricaoPush(sub);
      limparDismissPushPrompt();
      fecharModalAtivarPush();
      atualizarBannerPush();
      await mostrarNotificacaoSistema(
        "Notificações ativas",
        "Você receberá avisos de lançamentos e pendências.",
        "despesas-teste"
      );
      toast("Notificações ativadas neste aparelho.");
      return true;
    } catch (err) {
      console.error(err);
      toast("Não foi possível ativar o push. Instale o PWA e tente de novo.");
      return false;
    }
  }

  async function carregarWebPushLib() {
    if (pushBuildRequest) return pushBuildRequest;
    try {
      const mod = await import("https://esm.sh/@block65/webcrypto-web-push@1.0.2");
      pushBuildRequest = mod.buildPushPayload || mod.default?.buildPushPayload || null;
      return pushBuildRequest;
    } catch (err) {
      console.warn("web push lib:", err);
      pushBuildRequest = null;
      return null;
    }
  }

  async function enfileirarWebPush(userId, subscription, titulo, texto, tag) {
    if (!firebasePronto() || !codigoCasa || !subscription?.endpoint) return null;
    const jobId = uid();
    try {
      await firebase
        .database()
        .ref(`casas/${codigoCasa}/pushQueue/${jobId}`)
        .set({
          userId: userId || null,
          subscription,
          title: String(titulo || "Despesas").slice(0, 80),
          body: String(texto || "").slice(0, 180),
          tag: tag || jobId,
          createdAt: Date.now(),
        });
      return jobId;
    } catch (err) {
      console.warn("fila push:", err);
      return null;
    }
  }

  async function enviarViaRelay(subscription, titulo, texto, tag) {
    const vapid = window.VAPID_CONFIG;
    const relay = String(vapid?.relayUrl || "").trim();
    if (!relay) return false;
    const res = await fetch(relay, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription,
        title: titulo,
        body: texto,
        tag: tag || "despesas",
        vapid: {
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
          subject: vapid.subject || "mailto:familia@despesas.local",
        },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn("relay push:", res.status, t);
      return false;
    }
    return true;
  }

  async function enviarViaCorsProxy(subscription, titulo, texto, tag) {
    const vapid = window.VAPID_CONFIG;
    if (!vapid?.publicKey || !vapid?.privateKey) return false;
    const build = await carregarWebPushLib();
    if (!build) return false;

    const init = await build(
      {
        data: JSON.stringify({
          title: titulo,
          body: texto,
          tag: tag || "despesas",
        }),
        options: { ttl: 60 * 60, urgency: "high" },
      },
      subscription,
      {
        subject: vapid.subject || "mailto:familia@despesas.local",
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      }
    );

    // 1) tentativa direta (quase sempre bloqueada por CORS)
    try {
      const r = await fetch(subscription.endpoint, init);
      if (r.ok || r.status === 201) return true;
    } catch {
      /* CORS esperado */
    }

    // 2) proxy público (best-effort; pode falhar)
    try {
      const proxied = `https://corsproxy.io/?${encodeURIComponent(subscription.endpoint)}`;
      const r2 = await fetch(proxied, {
        method: init.method || "POST",
        headers: init.headers,
        body: init.body,
      });
      if (r2.ok || r2.status === 201) return true;
    } catch (err) {
      console.warn("corsproxy push:", err);
    }
    return false;
  }

  async function enviarWebPushParaUsuario(userId, titulo, texto, tag) {
    if (!firebasePronto() || !codigoCasa || !userId) return;
    const vapid = window.VAPID_CONFIG;
    if (!vapid?.publicKey || !vapid?.privateKey) return;

    try {
      const snap = await firebase.database().ref(`casas/${codigoCasa}/webpush/${userId}`).once("value");
      const row = snap.val();
      const subscription = row?.subscription;
      if (!subscription?.endpoint) return;

      // Sempre enfileira: o GitHub Actions envia mesmo com o app fechado
      const jobId = await enfileirarWebPush(userId, subscription, titulo, texto, tag);

      // Tentativa instantânea (relay Cloudflare ou proxy)
      let sent = false;
      try {
        sent = await enviarViaRelay(subscription, titulo, texto, tag);
      } catch (err) {
        console.warn("relay:", err);
      }
      if (!sent) {
        try {
          sent = await enviarViaCorsProxy(subscription, titulo, texto, tag);
        } catch (err) {
          console.warn("proxy push:", err);
        }
      }

      // Se já entregou, tira da fila para não duplicar no Actions
      if (sent && jobId) {
        try {
          await firebase.database().ref(`casas/${codigoCasa}/pushQueue/${jobId}`).remove();
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      console.warn("enviar webpush:", err);
    }
  }

  function notificar({ paraUserIds, titulo, texto, tipo = "info", refId = null }) {
    const ids = [...new Set((paraUserIds || []).filter(Boolean))];
    const agora = new Date().toISOString();
    const criadas = [];
    ids.forEach((paraUserId) => {
      const item = {
        id: uid(),
        paraUserId,
        titulo,
        texto,
        tipo,
        refId,
        lida: false,
        criadoEm: agora,
      };
      state.notificacoes.unshift(item);
      criadas.push(item);
    });
    if (state.notificacoes.length > 300) {
      state.notificacoes = state.notificacoes.slice(0, 300);
    }

    // Push no celular dos destinatários (app instalado + permissão)
    criadas.forEach((item) => {
      enviarWebPushParaUsuario(item.paraUserId, item.titulo, item.texto, item.id);
    });
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
    const pessoa = { id: uid(), nome, precisaDefinirSenha: true };
    state.pessoas.push(pessoa);
    saveState();
    return pessoa;
  }

  function entrarComo(pessoa, opcoes = {}) {
    const manter =
      typeof opcoes.manterConectado === "boolean"
        ? opcoes.manterConectado
        : localStorage.getItem(REMEMBER_KEY) === "1";
    usuarioAtualId = pessoa.id;
    persistirSessao(pessoa.id, manter);
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
    atualizarPushStatus();
    if (notificacoesHabilitadas()) {
      navigator.serviceWorker.ready
        .then((reg) => reg.pushManager.getSubscription())
        .then((sub) => {
          if (sub) return salvarInscricaoPush(sub);
        })
        .catch(() => {});
    }
    toast(`Bem-vindo(a), ${pessoa.nome}${isAdmin() ? " (admin)" : ""}!`);
    talvezPedirNotificacoes();
  }

  function sair() {
    stopSync();
    usuarioAtualId = null;
    limparSessaoPersistida();
    $("#app").classList.add("hidden");
    $("#tela-login").classList.remove("hidden");
    fecharModalAtivarPush();
    atualizarBannerPush();
    renderLoginUI();
    const sel = $("#login-usuario");
    if (sel) sel.value = "";
    const adminInput = $("#login-nome-admin");
    if (adminInput) adminInput.value = "";
    limparCamposSenhaLogin();
    if (codigoCasa) $("#login-casa").value = CASA_PADRAO;
    setSyncStatus(firebasePronto() ? (navigator.onLine ? "offline" : "offline") : "local");
    syncCheckboxManterConectado();
    atualizarCamposSenhaLogin();
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
          .map((p) => {
            const tag = pessoaPrecisaDefinirSenha(p) ? " · definir senha" : "";
            return `<option value="${p.id}">${escapeHtml(p.nome)}${tag}</option>`;
          })
          .join("");
      if (prev && state.pessoas.some((p) => p.id === prev)) select.value = prev;
    }
    if (adminInput) adminInput.required = vazio;
    atualizarCamposSenhaLogin();
  }

  function syncCheckboxManterConectado() {
    const manter = $("#login-manter-conectado");
    if (!manter) return;
    const flag = localStorage.getItem(REMEMBER_KEY);
    manter.checked = flag !== "0";
  }

  function initLogin() {
    $("#login-usuario")?.addEventListener("change", () => {
      limparCamposSenhaLogin();
      atualizarCamposSenhaLogin();
    });

    $("#form-login").addEventListener("submit", async (e) => {
      e.preventDefault();
      const casa = CASA_PADRAO;
      const idAntes = $("#login-usuario")?.value || "";
      const nomeAntes = $("#login-usuario")?.selectedOptions?.[0]?.textContent?.trim() || "";
      const nomeAdmin = $("#login-nome-admin")?.value || "";
      const senhaAntes = ($("#login-senha")?.value || "").trim();
      const senhaConfAntes = ($("#login-senha-confirma")?.value || "").trim();
      const manterAntes = manterConectadoMarcado();

      await startSync(casa);
      renderLoginUI();
      if (idAntes && $("#login-usuario") && state.pessoas.some((p) => p.id === idAntes)) {
        $("#login-usuario").value = idAntes;
        atualizarCamposSenhaLogin();
      }
      if ($("#login-senha")) $("#login-senha").value = senhaAntes;
      if ($("#login-senha-confirma")) $("#login-senha-confirma").value = senhaConfAntes;
      if ($("#login-manter-conectado")) $("#login-manter-conectado").checked = manterAntes;

      const opLogin = { manterConectado: manterAntes };
      let pessoa = null;
      const primeiroAcesso = !state.pessoas.length;
      try {
        if (primeiroAcesso) {
          pessoa = bootstrapAdminSeVazio(nomeAdmin);
          if (!pessoa) {
            return toast("Primeiro acesso: use o nome do admin (Paulo).");
          }
          const nova = validarNovaSenhaDigitada();
          if (!nova) return;
          await definirSenhaPessoa(pessoa, nova);
          saveState();
          schedulePush();
          entrarComo(pessoa, opLogin);
          toast("Admin criado. Senha definida.");
          return;
        }

        pessoa =
          state.pessoas.find((p) => p.id === ($("#login-usuario")?.value || idAntes)) ||
          buscarPessoaCadastrada((nomeAntes || "").split("·")[0].trim());
        if (!pessoa) {
          return toast("Selecione seu usuário cadastrado para entrar.");
        }

        if (pessoaPrecisaDefinirSenha(pessoa)) {
          const nova = validarNovaSenhaDigitada();
          if (!nova) return;
          await definirSenhaPessoa(pessoa, nova);
          saveState();
          schedulePush();
          entrarComo(pessoa, opLogin);
          toast("Senha salva. Bem-vindo(a)!");
          return;
        }

        const senha = ($("#login-senha")?.value || "").trim();
        if (!senha) return toast("Informe sua senha.");
        const ok = await senhaConfere(pessoa, senha);
        if (!ok) return toast("Senha incorreta.");

        schedulePush();
        entrarComo(pessoa, opLogin);
      } catch (err) {
        console.warn(err);
        toast(err?.message || "Não foi possível validar a senha.");
      }
    });

    $("#form-definir-senha")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pessoa = state.pessoas.find((p) => p.id === definirSenhaCtxId);
      if (!pessoa) {
        fecharModalDefinirSenha();
        return toast("Usuário não encontrado.");
      }
      const nova = validarNovaSenhaDigitada($("#modal-senha-nova"), $("#modal-senha-confirma"));
      if (!nova) return;
      try {
        await definirSenhaPessoa(pessoa, nova);
        saveState();
        fecharModalDefinirSenha();
        renderPessoasLista();
        renderLoginUI();
        toast(`Senha de ${pessoa.nome} salva.`);
      } catch (err) {
        console.warn(err);
        toast(err?.message || "Não foi possível salvar a senha.");
      }
    });
    $("#btn-cancelar-definir-senha")?.addEventListener("click", () => fecharModalDefinirSenha());

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

    const admin = isAdmin();
    let acoesAdmin = "";
    if (admin) {
      if (aberto) {
        acoesAdmin = `<button type="button" class="btn btn--secondary btn--sm btn-mes-topo-fechar">Encerrar mês</button>`;
      } else {
        acoesAdmin = `<button type="button" class="btn btn--primary btn--sm btn-mes-topo-abrir">Abrir mês</button>`;
      }
    }

    if (aberto) {
      box.classList.add("mes-status--aberto");
      box.innerHTML = `
        <div class="mes-status__info">
          <span class="mes-status__label">Mês aberto</span>
          <span class="mes-status__valor">${aberto.label}</span>
        </div>
        <div class="mes-status__right">
          <span class="badge badge--aberto">Aberto</span>
          ${acoesAdmin}
        </div>`;
    } else if (state.meses.length) {
      box.classList.add("mes-status--fechado");
      box.innerHTML = `
        <div class="mes-status__info">
          <span class="mes-status__label">Situação</span>
          <span class="mes-status__valor">Nenhum mês aberto</span>
        </div>
        <div class="mes-status__right">
          <span class="badge badge--fechado">Fechado</span>
          ${acoesAdmin}
        </div>`;
    } else {
      box.classList.add("mes-status--nenhum");
      box.innerHTML = `
        <div class="mes-status__info">
          <span class="mes-status__label">Situação</span>
          <span class="mes-status__valor">Abra um mês para começar</span>
        </div>
        <div class="mes-status__right">
          <span class="badge badge--nenhum">Sem mês</span>
          ${acoesAdmin}
        </div>`;
    }

    box.querySelector(".btn-mes-topo-abrir")?.addEventListener("click", () => {
      $("#btn-abrir-mes")?.click();
    });
    box.querySelector(".btn-mes-topo-fechar")?.addEventListener("click", () => {
      $("#btn-fechar-mes")?.click();
    });

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
    if (btnFechar) btnFechar.disabled = !aberto || !admin;
    if (btnAbrir) btnAbrir.disabled = !admin;
    const hintMes = $("#hint-mes-admin");
    if (hintMes) {
      hintMes.textContent = admin
        ? "Você é admin: pode abrir e encerrar o mês aqui ou no topo da tela."
        : "Somente Paulo (admin) pode abrir e encerrar o mês.";
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
        const acoes = [];
        const fotoBtn = htmlBtnComprovante(item, {
          kind: "lancamento",
          canAdd: !!(meu && podeExcluirMes && !srcComprovante(item)),
          canRemove: !!(meu && podeExcluirMes && srcComprovante(item)),
        });
        if (fotoBtn) acoes.push(fotoBtn);
        if (meu && podeExcluirMes) {
          acoes.push(
            `<button type="button" class="btn btn--edit btn--sm btn-editar-mercado" data-id="${item.id}" title="Editar">✎</button>`
          );
          acoes.push(
            `<button type="button" class="btn btn--ghost btn--sm btn-excluir-mercado" data-id="${item.id}">Excluir</button>`
          );
        }
        return `
      <article class="mercado-item">
        <div>
          <p class="mercado-item__meta">${formatDate(item.data)} · ${escapeHtml(PAGAMENTOS[item.pagamento] || item.pagamento || "—")}</p>
          <p class="mercado-item__detalhe">${escapeHtml(labelComprador(item.comprador))}</p>
        </div>
        <p class="mercado-item__valor">${formatMoney(item.valor)}</p>
        <div class="mercado-item__rodape">
          <p class="mercado-item__por">Por ${escapeHtml(item.lancadoPorNome || "—")}</p>
          <div class="mercado-item__acoes">${acoes.join("")}</div>
        </div>
      </article>`;
      })
      .join("");

    wireComprovanteListEvents(box);

    box.querySelectorAll(".btn-editar-mercado").forEach((btn) => {
      btn.addEventListener("click", () => iniciarEdicaoMercado(btn.dataset.id));
    });

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

        if (item.comprovantePath) excluirComprovanteStorage(item.comprovantePath);
        const autor = autorMeta();
        state.lancamentos = state.lancamentos.filter((l) => l.id !== item.id);
        notificarTodosExceto(autor.lancadoPorId, {
          titulo: "Mercado excluído",
          texto: `${autor.lancadoPorNome} excluiu um mercado de ${formatMoney(item.valor)}.`,
          tipo: "exclusao",
          refId: item.id,
        });
        saveState();
        clearTimeout(pushTimer);
        pushToCloud();
        updateNotifBadge();
        renderMercadoLista();
        renderRelatorio();
        toast("Mercado excluído.");
      });
    });
  }

  function limparEdicaoMercado() {
    editingMercadoId = null;
    limparComprovanteCampo("mercado");
    const form = $("#form-mercado");
    form?.reset();
    if ($("#mercado-data")) $("#mercado-data").value = todayISO();
    fillSelectCompradores();
    setEditModeButtons(
      "#btn-salvar-mercado",
      "#btn-cancelar-mercado",
      false,
      "Salvar mercado",
      "Salvar alterações"
    );
  }

  function iniciarEdicaoMercado(id) {
    const item = state.lancamentos.find((l) => l.id === id && l.tipo === "mercado");
    if (!item) return;
    if (item.lancadoPorId !== usuarioAtualId) return toast("Só quem lançou pode editar.");
    if (!mesEstaAberto(item.mesId)) return toast("Só é possível editar no mês aberto.");
    editingMercadoId = item.id;
    limparComprovanteCampo("mercado");
    fillSelectCompradores();
    $("#mercado-data").value = item.data || todayISO();
    $("#mercado-comprador").value = item.comprador || "";
    $("#mercado-pagamento").value = item.pagamento || "pix";
    setMoneyInput("#mercado-valor", item.valor);
    const src = srcComprovante(item);
    if (src) {
      comprovanteExistente.mercado = {
        url: item.comprovanteUrl || null,
        path: item.comprovantePath || null,
        data: item.comprovanteData || null,
      };
      comprovanteRemovido.mercado = false;
      mostrarPreviewComprovante("mercado", src);
    }
    setEditModeButtons(
      "#btn-salvar-mercado",
      "#btn-cancelar-mercado",
      true,
      "Salvar mercado",
      "Salvar alterações"
    );
    $("#form-mercado")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
        const acoes = [];
        const fotoBtn = htmlBtnComprovante(item, {
          kind: "lancamento",
          canAdd: !!(meu && podeExcluirMes && !srcComprovante(item)),
          canRemove: !!(meu && podeExcluirMes && srcComprovante(item)),
        });
        if (fotoBtn) acoes.push(fotoBtn);
        if (meu && podeExcluirMes) {
          acoes.push(
            `<button type="button" class="btn btn--edit btn--sm btn-editar-despesa" data-id="${item.id}" title="Editar">✎</button>`
          );
          acoes.push(
            `<button type="button" class="btn btn--ghost btn--sm btn-excluir-despesa" data-id="${item.id}">Excluir</button>`
          );
        }
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
          <div class="mercado-item__acoes">${acoes.join("")}</div>
        </div>
      </article>`;
      })
      .join("");

    wireComprovanteListEvents(box);

    box.querySelectorAll(".btn-editar-despesa").forEach((btn) => {
      btn.addEventListener("click", () => iniciarEdicaoDespesa(btn.dataset.id));
    });

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

        if (item.comprovantePath) excluirComprovanteStorage(item.comprovantePath);
        const autor = autorMeta();
        state.lancamentos = state.lancamentos.filter((l) => l.id !== item.id);
        notificarTodosExceto(autor.lancadoPorId, {
          titulo: "Despesa excluída",
          texto: `${autor.lancadoPorNome} excluiu "${item.descricao}" (${formatMoney(item.valor)}).`,
          tipo: "exclusao",
          refId: item.id,
        });
        saveState();
        clearTimeout(pushTimer);
        pushToCloud();
        updateNotifBadge();
        renderDespesaLista();
        renderRelatorio();
        toast("Despesa excluída.");
      });
    });
  }

  function limparEdicaoDespesa() {
    editingDespesaId = null;
    limparComprovanteCampo("despesa");
    const form = $("#form-despesa");
    form?.reset();
    if ($("#despesa-data")) $("#despesa-data").value = todayISO();
    fillSelectTiposDespesa();
    fillSelectCompradores();
    setEditModeButtons(
      "#btn-salvar-despesa",
      "#btn-cancelar-despesa",
      false,
      "Salvar despesa",
      "Salvar alterações"
    );
  }

  function iniciarEdicaoDespesa(id) {
    const item = state.lancamentos.find((l) => l.id === id && l.tipo === "despesa");
    if (!item) return;
    if (item.lancadoPorId !== usuarioAtualId) return toast("Só quem lançou pode editar.");
    if (!mesEstaAberto(item.mesId)) return toast("Só é possível editar no mês aberto.");
    editingDespesaId = item.id;
    limparComprovanteCampo("despesa");
    fillSelectTiposDespesa(item.descricao || "");
    fillSelectCompradores();
    $("#despesa-descricao").value = item.descricao || "";
    $("#despesa-data").value = item.data || todayISO();
    $("#despesa-comprador").value = item.comprador || "";
    $("#despesa-pagamento").value = item.pagamento || "pix";
    $("#despesa-criterio").value = item.criterio === "igual_3" ? "igual_3" : "proporcional";
    setMoneyInput("#despesa-valor", item.valor);
    const src = srcComprovante(item);
    if (src) {
      comprovanteExistente.despesa = {
        url: item.comprovanteUrl || null,
        path: item.comprovantePath || null,
        data: item.comprovanteData || null,
      };
      comprovanteRemovido.despesa = false;
      mostrarPreviewComprovante("despesa", src);
    }
    setEditModeButtons(
      "#btn-salvar-despesa",
      "#btn-cancelar-despesa",
      true,
      "Salvar despesa",
      "Salvar alterações"
    );
    $("#form-despesa")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    bindMoneyInputs();
    initComprovanteCampos();

    $("#form-mercado").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!mesAberto()) return toast("Abra um mês antes de lançar.");
      const data = $("#mercado-data").value;
      const comprador = $("#mercado-comprador").value;
      const pagamento = $("#mercado-pagamento").value;
      const valor = parseMoneyInput($("#mercado-valor").value);
      if (!data || !comprador || !pagamento || !(valor > 0)) return toast("Preencha todos os campos.");
      if (data.slice(0, 7) !== state.mesAtual) return toast(`A data deve pertencer a ${labelMes(state.mesAtual)}.`);

      const autor = autorMeta();
      const divisao = dividirValor(valor, "proporcional");

      if (editingMercadoId) {
        const existente = state.lancamentos.find(
          (l) => l.id === editingMercadoId && l.tipo === "mercado"
        );
        if (!existente) {
          limparEdicaoMercado();
          return toast("Lançamento não encontrado.");
        }
        if (existente.lancadoPorId !== usuarioAtualId) {
          return toast("Só quem lançou pode editar.");
        }
        if (!mesEstaAberto(existente.mesId)) {
          return toast("Só é possível editar no mês aberto.");
        }
        existente.data = data;
        existente.comprador = comprador;
        existente.pagamento = pagamento;
        existente.valor = valor;
        existente.criterio = "proporcional";
        existente.divisao = divisao;
        try {
          await aplicarComprovanteNoItem(existente, "mercado");
        } catch (err) {
          console.warn(err);
          return toast("Não foi possível enviar a foto.");
        }
        notificarTodosExceto(autor.lancadoPorId, {
          titulo: "Mercado editado",
          texto: `${autor.lancadoPorNome} editou um mercado para ${formatMoney(valor)} (${formatDate(data)}).`,
          tipo: "mercado",
          refId: existente.id,
        });
        saveState();
        updateNotifBadge();
        limparEdicaoMercado();
        renderMercadoLista();
        renderRelatorio();
        renderEncontro();
        toast("Mercado atualizado.");
        return;
      }

      const item = {
        id: uid(),
        mesId: state.mesAtual,
        tipo: "mercado",
        data,
        comprador,
        pagamento,
        valor,
        criterio: "proporcional",
        divisao,
        ...autor,
        criadoEm: new Date().toISOString(),
      };
      try {
        await aplicarComprovanteNoItem(item, "mercado");
      } catch (err) {
        console.warn(err);
        return toast("Não foi possível enviar a foto.");
      }
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
      limparComprovanteCampo("mercado");
      $("#mercado-data").value = todayISO();
      fillSelectCompradores();
      renderMercadoLista();
      toast("Mercado lançado.");
    });

    $("#btn-cancelar-mercado")?.addEventListener("click", () => {
      limparEdicaoMercado();
      toast("Edição cancelada.");
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

    $("#form-despesa").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!mesAberto()) return toast("Abra um mês antes de lançar.");
      if (!state.tiposDespesa.length) return toast("Cadastre ao menos um tipo de despesa.");
      const descricao = $("#despesa-descricao").value.trim();
      const data = $("#despesa-data").value;
      const comprador = $("#despesa-comprador").value;
      const pagamento = $("#despesa-pagamento").value;
      const criterio = $("#despesa-criterio").value;
      const valor = parseMoneyInput($("#despesa-valor").value);
      if (!descricao || !data || !comprador || !pagamento || !criterio || !(valor > 0)) {
        return toast("Preencha todos os campos.");
      }
      if (!state.tiposDespesa.some((t) => t.nome === descricao)) {
        return toast("Selecione uma despesa cadastrada.");
      }
      if (data.slice(0, 7) !== state.mesAtual) return toast(`A data deve pertencer a ${labelMes(state.mesAtual)}.`);

      const autor = autorMeta();
      const divisao = dividirValor(valor, criterio);

      if (editingDespesaId) {
        const existente = state.lancamentos.find(
          (l) => l.id === editingDespesaId && l.tipo === "despesa"
        );
        if (!existente) {
          limparEdicaoDespesa();
          return toast("Lançamento não encontrado.");
        }
        if (existente.lancadoPorId !== usuarioAtualId) {
          return toast("Só quem lançou pode editar.");
        }
        if (!mesEstaAberto(existente.mesId)) {
          return toast("Só é possível editar no mês aberto.");
        }
        existente.descricao = descricao;
        existente.data = data;
        existente.comprador = comprador;
        existente.pagamento = pagamento;
        existente.criterio = criterio;
        existente.valor = valor;
        existente.divisao = divisao;
        try {
          await aplicarComprovanteNoItem(existente, "despesa");
        } catch (err) {
          console.warn(err);
          return toast("Não foi possível enviar a foto.");
        }
        notificarTodosExceto(autor.lancadoPorId, {
          titulo: "Despesa editada",
          texto: `${autor.lancadoPorNome} editou "${descricao}" para ${formatMoney(valor)}.`,
          tipo: "despesa",
          refId: existente.id,
        });
        saveState();
        updateNotifBadge();
        limparEdicaoDespesa();
        renderDespesaLista();
        renderRelatorio();
        renderEncontro();
        toast("Despesa atualizada.");
        return;
      }

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
        divisao,
        ...autor,
        criadoEm: new Date().toISOString(),
      };
      try {
        await aplicarComprovanteNoItem(item, "despesa");
      } catch (err) {
        console.warn(err);
        return toast("Não foi possível enviar a foto.");
      }
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
      limparComprovanteCampo("despesa");
      $("#despesa-data").value = todayISO();
      fillSelectTiposDespesa();
      fillSelectCompradores();
      renderDespesaLista();
      toast("Despesa lançada.");
    });

    $("#btn-cancelar-despesa")?.addEventListener("click", () => {
      limparEdicaoDespesa();
      toast("Edição cancelada.");
    });

    $("#form-pessoa").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!isAdmin()) return toast("Somente o admin pode cadastrar usuários.");
      const nome = $("#pessoa-nome").value.trim().replace(/\s+/g, " ");
      if (!nome) return toast("Informe o nome.");
      if (state.pessoas.some((p) => p.nome.toLowerCase() === nome.toLowerCase())) {
        return toast("Esse usuário já está cadastrado.");
      }
      state.pessoas.push({ id: uid(), nome, precisaDefinirSenha: true });
      state.pessoas.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
      saveState();
      e.target.reset();
      renderPessoasLista();
      renderVaquinhaUI();
      fillPendenciaPessoas();
      renderLoginUI();
      toast(`${nome} cadastrado(a).`);
    });

    $("#form-vaquinha").addEventListener("submit", async (e) => {
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

      try {
        await aplicarFotosNasCompras(compras);
      } catch (err) {
        console.warn(err);
        return toast("Não foi possível enviar a notinha de uma compra.");
      }

      const autor = autorMeta();
      const participantes = calcularAcerto(compras, participantesBase);

      if (editingVaquinhaId) {
        const existente = state.lancamentos.find(
          (l) => l.id === editingVaquinhaId && l.tipo === "vaquinha"
        );
        if (!existente) {
          limparEdicaoVaquinha();
          return toast("Vaquinha não encontrada.");
        }
        if (existente.lancadoPorId !== usuarioAtualId && !isAdmin()) {
          return toast("Só quem lançou (ou o admin) pode editar.");
        }
        if (!mesEstaAberto(existente.mesId)) {
          return toast("Só é possível editar no mês aberto.");
        }
        existente.descricao = descricao;
        existente.data = data;
        existente.compras = compras;
        existente.valor = total;
        existente.participantes = participantes;
        try {
          await aplicarComprovanteNoItem(existente, "vaquinha");
        } catch (err) {
          console.warn(err);
          return toast("Não foi possível enviar a foto.");
        }
        notificarTodosExceto(autor.lancadoPorId, {
          titulo: "Vaquinha editada",
          texto: `${autor.lancadoPorNome} editou a vaquinha "${descricao}" (${formatMoney(total)}).`,
          tipo: "vaquinha",
          refId: existente.id,
        });
        saveState();
        updateNotifBadge();
        limparEdicaoVaquinha();
        renderVaquinhaLista();
        renderRelatorio();
        renderEncontro();
        toast("Vaquinha atualizada.");
        return;
      }

      const item = {
        id: uid(),
        mesId: state.mesAtual,
        tipo: "vaquinha",
        descricao,
        data,
        compras,
        valor: total,
        participantes,
        status: "pendente",
        pagoEm: null,
        pagoPorId: null,
        ...autor,
        criadoEm: new Date().toISOString(),
      };
      try {
        await aplicarComprovanteNoItem(item, "vaquinha");
      } catch (err) {
        console.warn(err);
        return toast("Não foi possível enviar a foto.");
      }
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
      limparEdicaoVaquinha();
      renderVaquinhaLista();
      renderRelatorio();
      renderEncontro();
      toast("Vaquinha salva.");
    });

    $("#btn-cancelar-vaquinha")?.addEventListener("click", () => {
      limparEdicaoVaquinha();
      toast("Edição cancelada.");
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
      if (!isAdmin()) return toast("Somente Paulo pode encerrar o mês.");
      const aberto = mesAberto();
      if (!aberto) return toast("Não há mês aberto.");
      if (!confirm(`Encerrar ${aberto.label}? Não será possível lançar mercado/despesas/vaquinha até abrir outro.`)) return;
      const autor = autorMeta();
      aberto.status = "fechado";
      aberto.fechadoEm = new Date().toISOString();
      aberto.fechadoPorNome = autor.lancadoPorNome;
      state.mesAtual = null;
      notificarTodosExceto(autor.lancadoPorId, {
        titulo: "Mês encerrado",
        texto: `${autor.lancadoPorNome} encerrou ${aberto.label}.`,
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
      toast(`${aberto.label} encerrado.`);
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
    state.pessoalReceitas = (state.pessoalReceitas || []).filter((p) => p.donoId !== pessoaId);
    state.pessoalAcessos = (state.pessoalAcessos || []).filter(
      (a) => a.donoId !== pessoaId && a.viewerId !== pessoaId
    );
    state.pessoalTipos = (state.pessoalTipos || []).filter((t) => t.donoId !== pessoaId);
    state.pessoalTiposReceita = (state.pessoalTiposReceita || []).filter((t) => t.donoId !== pessoaId);
    state.pessoalCategorias = (state.pessoalCategorias || []).filter((c) => c.donoId !== pessoaId);
    state.pessoalPagamentos = (state.pessoalPagamentos || []).filter((p) => p.donoId !== pessoaId);
    state.pessoalDespesasFixas = (state.pessoalDespesasFixas || []).filter((f) => f.donoId !== pessoaId);
  }

  function listaCadastroPessoal(chave, donoId) {
    return (state[chave] || [])
      .filter((x) => x && x.donoId === donoId && x.nome)
      .sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR"));
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
    seed("pessoalTiposReceita", DEFAULT_PESSOAL_TIPOS_RECEITA);
    seed("pessoalCategorias", DEFAULT_PESSOAL_CATEGORIAS);
    seed("pessoalPagamentos", DEFAULT_PESSOAL_PAGAMENTOS);
    return mudou;
  }

  function labelTipoReceita(item) {
    if (item.tipoNome) return item.tipoNome;
    if (item.tipoId) {
      const t = (state.pessoalTiposReceita || []).find((x) => x.id === item.tipoId);
      if (t) return t.nome;
    }
    return "—";
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
    (state.pessoalReceitas || [])
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
    const tiposRec = listaCadastroPessoal("pessoalTiposReceita", donoId);
    const cats = listaCadastroPessoal("pessoalCategorias", donoId);
    const pags = listaCadastroPessoal("pessoalPagamentos", donoId);

    const fillSelect = (sel, items, prev) => {
      if (!sel) return;
      sel.innerHTML =
        `<option value="">Selecione…</option>` +
        items.map((t) => `<option value="${t.id}">${escapeHtml(t.nome)}</option>`).join("");
      if (prev && items.some((t) => t.id === prev)) sel.value = prev;
    };

    fillSelect($("#pessoal-tipo"), tipos, $("#pessoal-tipo")?.value);
    fillSelect($("#pessoal-categoria"), cats, $("#pessoal-categoria")?.value);
    fillSelect($("#pessoal-pagamento"), pags, $("#pessoal-pagamento")?.value);
    fillSelect($("#receita-tipo"), tiposRec, $("#receita-tipo")?.value);
    fillSelect($("#receita-pagamento"), pags, $("#receita-pagamento")?.value);
    fillSelect($("#fixa-tipo"), tipos, $("#fixa-tipo")?.value);
    fillSelect($("#fixa-categoria"), cats, $("#fixa-categoria")?.value);

    // Prefere "Assinatura" no cadastro de fixas, se existir
    const tipoFixa = $("#fixa-tipo");
    if (tipoFixa && !tipoFixa.value) {
      const assinatura = tipos.find((t) => /assinatura/i.test(t.nome));
      if (assinatura) tipoFixa.value = assinatura.id;
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
    const boxes = [
      "#pessoal-cadastros",
      "#pessoal-bloco-despesa",
      "#pessoal-bloco-receita",
      "#pessoal-bloco-fixas",
    ];
    boxes.forEach((sel) => {
      const box = $(sel);
      if (!box) return;
      box.classList.toggle("hidden", !podeEditar);
      $$(`${sel} input, ${sel} select, ${sel} button`).forEach((el) => {
        el.disabled = !podeEditar;
      });
    });
    if (!podeEditar) return;

    renderListaCadastroPessoal({
      chave: "pessoalTipos",
      listaId: "#lista-pessoal-tipos",
      emptyId: "#empty-pessoal-tipos",
      btnClass: "btn-rm-pessoal-tipo",
      podeEditar,
    });
    renderListaCadastroPessoal({
      chave: "pessoalTiposReceita",
      listaId: "#lista-pessoal-tipos-rec",
      emptyId: "#empty-pessoal-tipos-rec",
      btnClass: "btn-rm-pessoal-tipo-rec",
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

  function diasNoMes(mesId) {
    const [y, m] = String(mesId || "").split("-").map(Number);
    if (!y || !m) return 28;
    return new Date(y, m, 0).getDate();
  }

  function dataParaFixaNoMes(mesId, diaVencimento) {
    const mes = mesId || currentMonthId();
    const hoje = todayISO();
    if (hoje.startsWith(mes)) return hoje;
    const max = diasNoMes(mes);
    const dia = Math.min(Math.max(Number(diaVencimento) || 1, 1), max);
    return `${mes}-${String(dia).padStart(2, "0")}`;
  }

  function fixaPagaNoMes(fixaId, donoId, mesId) {
    return (state.pessoais || []).some(
      (p) =>
        p &&
        p.fixaId === fixaId &&
        p.donoId === donoId &&
        (p.data || "").slice(0, 7) === mesId
    );
  }

  function listaDespesasFixas(donoId) {
    return (state.pessoalDespesasFixas || [])
      .filter((f) => f && f.donoId === donoId && f.ativo !== false)
      .sort((a, b) => {
        const da = Number(a.diaVencimento) || 99;
        const db = Number(b.diaVencimento) || 99;
        if (da !== db) return da - db;
        return String(a.descricao || "").localeCompare(String(b.descricao || ""), "pt-BR");
      });
  }

  function renderPessoalFixas(donoId, podeEditar) {
    const box = $("#lista-pessoal-fixas");
    const empty = $("#empty-pessoal-fixas");
    const pendEl = $("#pessoal-fixas-pendentes");
    if (!box || !empty) return;

    const mesId = pessoalMesId || currentMonthId();
    const fixas = listaDespesasFixas(donoId);
    const pags = listaCadastroPessoal("pessoalPagamentos", donoId);
    const pendentes = fixas.filter((f) => !fixaPagaNoMes(f.id, donoId, mesId)).length;

    if (pendEl) {
      pendEl.textContent = fixas.length
        ? pendentes
          ? `${pendentes} pendente${pendentes > 1 ? "s" : ""}`
          : "em dia"
        : "";
    }

    if (!fixas.length) {
      box.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    const optsPag =
      `<option value="">Pagamento…</option>` +
      pags.map((p) => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join("");

    box.innerHTML = fixas
      .map((f) => {
        const paga = fixaPagaNoMes(f.id, donoId, mesId);
        const cat = f.categoriaNome || labelCategoriaPessoal(f);
        const dia = f.diaVencimento ? `dia ${f.diaVencimento}` : "sem dia";
        let acao = "";
        if (podeEditar) {
          if (paga) {
            acao = `<span class="fixa-item__badge">Pago em ${escapeHtml(labelMes(mesId))}</span>
               <button type="button" class="btn btn--ghost btn--sm btn-desfazer-fixa" data-id="${f.id}">Desfazer</button>`;
          } else {
            acao = `<select class="fixa-item__pag" data-id="${f.id}" aria-label="Forma de pagamento">${optsPag}</select>
               <button type="button" class="btn btn--primary btn--sm btn-pagar-fixa" data-id="${f.id}">Pagar</button>`;
          }
        }
        const editar = podeEditar
          ? `<button type="button" class="btn btn--edit btn--sm btn-editar-fixa" data-id="${f.id}" title="Editar">✎</button>`
          : "";
        const excluir = podeEditar
          ? `<button type="button" class="btn btn--icon btn-excluir-fixa" data-id="${f.id}" title="Remover fixa" aria-label="Remover">×</button>`
          : "";
        return `
      <article class="fixa-item ${paga ? "fixa-item--paga" : ""}">
        <div class="fixa-item__texto">
          <p class="fixa-item__titulo">${escapeHtml(f.descricao)}</p>
          <p class="fixa-item__meta">${escapeHtml(cat)} · ${dia} · ${formatMoney(f.valor)}</p>
        </div>
        <div class="fixa-item__acoes">
          ${acao}
          ${editar}
          ${excluir}
        </div>
      </article>`;
      })
      .join("");

    box.querySelectorAll(".btn-pagar-fixa").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pagId = btn.closest(".fixa-item")?.querySelector(".fixa-item__pag")?.value || "";
        pagarDespesaFixa(btn.dataset.id, donoId, pagId);
      });
    });
    box.querySelectorAll(".btn-desfazer-fixa").forEach((btn) => {
      btn.addEventListener("click", () => desfazerPagamentoFixa(btn.dataset.id, donoId));
    });
    box.querySelectorAll(".btn-editar-fixa").forEach((btn) => {
      btn.addEventListener("click", () => iniciarEdicaoFixa(btn.dataset.id, donoId));
    });
    box.querySelectorAll(".btn-excluir-fixa").forEach((btn) => {
      btn.addEventListener("click", () => excluirDespesaFixa(btn.dataset.id, donoId));
    });
  }

  function limparEdicaoFixa(donoId) {
    editingFixaId = null;
    const form = $("#form-pessoal-fixa");
    form?.reset();
    if (donoId) fillPessoalSelectsCadastro(donoId);
    setEditModeButtons(
      "#btn-salvar-fixa",
      "#btn-cancelar-fixa",
      false,
      "Cadastrar despesa fixa",
      "Salvar alterações"
    );
  }

  function iniciarEdicaoFixa(fixaId, donoId) {
    if (!podeEditarPessoalDe(donoId)) return toast("Sem permissão.");
    const fixa = (state.pessoalDespesasFixas || []).find(
      (f) => f.id === fixaId && f.donoId === donoId
    );
    if (!fixa) return;
    editingFixaId = fixa.id;
    fillPessoalSelectsCadastro(donoId);
    $("#fixa-descricao").value = fixa.descricao || "";
    setMoneyInput("#fixa-valor", fixa.valor);
    $("#fixa-tipo").value = fixa.tipoId || "";
    $("#fixa-categoria").value = fixa.categoriaId || "";
    $("#fixa-dia").value = fixa.diaVencimento || "";
    setEditModeButtons(
      "#btn-salvar-fixa",
      "#btn-cancelar-fixa",
      true,
      "Cadastrar despesa fixa",
      "Salvar alterações"
    );
    const bloco = $("#pessoal-bloco-fixas");
    if (bloco) bloco.open = true;
    $("#form-pessoal-fixa")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function desfazerPagamentoFixa(fixaId, donoId) {
    const u = usuarioAtual();
    if (!u) return toast("Faça login.");
    if (!podeEditarPessoalDe(donoId)) return toast("Sem permissão.");
    const fixa = (state.pessoalDespesasFixas || []).find(
      (f) => f.id === fixaId && f.donoId === donoId
    );
    if (!fixa) return;
    const mesId = pessoalMesId || currentMonthId();
    const lanc = (state.pessoais || []).find(
      (p) =>
        p &&
        p.fixaId === fixaId &&
        p.donoId === donoId &&
        (p.data || "").slice(0, 7) === mesId
    );
    if (!lanc) return toast("Pagamento deste mês não encontrado.");
    if (
      !confirm(
        `Desfazer o pagamento de "${fixa.descricao}" em ${labelMes(mesId)}?\nValor: ${formatMoney(lanc.valor)}`
      )
    ) {
      return;
    }
    state.pessoais = state.pessoais.filter((p) => p.id !== lanc.id);
    const outros = idsParticipantesPessoal(donoId, u.id);
    if (outros.length) {
      notificar({
        paraUserIds: outros,
        titulo: "Pagamento de fixa desfeito",
        texto: `${u.nome} desfez o pagamento de "${fixa.descricao}" (${formatMoney(lanc.valor)}) em ${labelMes(mesId)}.`,
        tipo: "pessoal",
        refId: lanc.id,
      });
    }
    saveState();
    updateNotifBadge();
    renderPessoal();
    toast("Pagamento desfeito.");
  }

  function pagarDespesaFixa(fixaId, donoId, pagamentoId) {
    const u = usuarioAtual();
    if (!u) return toast("Faça login.");
    if (!podeEditarPessoalDe(donoId)) return toast("Sem permissão.");

    const fixa = (state.pessoalDespesasFixas || []).find(
      (f) => f.id === fixaId && f.donoId === donoId
    );
    if (!fixa) return toast("Despesa fixa não encontrada.");

    const mesId = pessoalMesId || currentMonthId();
    if (fixaPagaNoMes(fixa.id, donoId, mesId)) {
      return toast("Esta fixa já foi paga neste mês.");
    }

    const pagamento = (state.pessoalPagamentos || []).find(
      (p) => p.id === pagamentoId && p.donoId === donoId
    );
    if (!pagamento) return toast("Escolha a forma de pagamento.");

    const dono = state.pessoas.find((p) => p.id === donoId) || u;
    const tipo =
      (state.pessoalTipos || []).find((t) => t.id === fixa.tipoId && t.donoId === donoId) ||
      null;
    const categoria =
      (state.pessoalCategorias || []).find(
        (c) => c.id === fixa.categoriaId && c.donoId === donoId
      ) || null;
    const data = dataParaFixaNoMes(mesId, fixa.diaVencimento);
    const valor = Number(fixa.valor) || 0;
    if (!(valor > 0)) return toast("Valor da fixa inválido.");

    const item = {
      id: uid(),
      donoId: dono.id,
      donoNome: dono.nome,
      descricao: fixa.descricao,
      data,
      tipoId: tipo?.id || fixa.tipoId || "",
      tipoNome: tipo?.nome || fixa.tipoNome || "Fixa",
      categoriaId: categoria?.id || fixa.categoriaId || "",
      categoriaNome: categoria?.nome || fixa.categoriaNome || "Outros",
      categoria: categoria?.nome || fixa.categoriaNome || "Outros",
      pagamentoId: pagamento.id,
      pagamentoNome: pagamento.nome,
      pagamento: pagamento.nome,
      valor,
      fixaId: fixa.id,
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
        titulo: "Despesa fixa paga",
        texto: `${u.nome} pagou "${fixa.descricao}" (${formatMoney(valor)}) em ${labelMes(mesId)}.`,
        tipo: "pessoal",
        refId: item.id,
      });
    }

    saveState();
    updateNotifBadge();
    pessoalMesId = mesId;
    renderPessoal();
    toast(`"${fixa.descricao}" lançada em ${labelMes(mesId)}.`);
  }

  function excluirDespesaFixa(fixaId, donoId) {
    if (!podeEditarPessoalDe(donoId)) return toast("Sem permissão.");
    const fixa = (state.pessoalDespesasFixas || []).find(
      (f) => f.id === fixaId && f.donoId === donoId
    );
    if (!fixa) return;
    if (!confirm(`Remover a despesa fixa "${fixa.descricao}"?\n(Lançamentos já feitos no mês não são apagados.)`)) {
      return;
    }
    state.pessoalDespesasFixas = (state.pessoalDespesasFixas || []).filter((f) => f.id !== fixaId);
    saveState();
    renderPessoal();
    toast("Despesa fixa removida.");
  }

  function renderPessoal() {
    try {
      renderPessoalInner();
    } catch (err) {
      console.warn("renderPessoal:", err);
    }
  }

  function renderPessoalInner() {
    const u = usuarioAtual();
    if (!u) return;

    fillPessoalListaSelect();
    fillPessoalMesSelect();

    const donoId = pessoalDonoId || u.id;
    if (ensurePessoalCadastros(donoId) && !applyingRemote) saveState();

    const podeVer = podeVerPessoalDe(donoId);
    const podeEditar = podeEditarPessoalDe(donoId);
    const souDono = donoId === u.id;
    const aviso = $("#aviso-pessoal-compartilhada");

    fillPessoalSelectsCadastro(donoId);
    renderPessoalCadastros(donoId, podeEditar);
    renderPessoalFixas(donoId, podeEditar);

    aviso?.classList.toggle("hidden", souDono || !podeVer);

    renderPessoalAcessos();

    const box = $("#lista-pessoal");
    const empty = $("#empty-pessoal");
    const totalBox = $("#pessoal-total");
    const resumoBox = $("#pessoal-resumo-financas");
    const porCatBox = $("#pessoal-por-categoria");
    const countEl = $("#pessoal-count");
    if (!box || !empty) return;

    if (!podeVer) {
      box.innerHTML = "";
      empty.textContent = "Você não tem acesso a esta lista.";
      empty.classList.remove("hidden");
      if (countEl) countEl.textContent = "0";
      totalBox?.classList.add("hidden");
      if (resumoBox) resumoBox.innerHTML = "";
      if (porCatBox) porCatBox.innerHTML = "";
      return;
    }

    const mesId = pessoalMesId || currentMonthId();
    const despesas = (state.pessoais || []).filter(
      (p) => p.donoId === donoId && (p.data || "").slice(0, 7) === mesId
    );
    const receitas = (state.pessoalReceitas || []).filter(
      (p) => p.donoId === donoId && (p.data || "").slice(0, 7) === mesId
    );
    const totalDesp = despesas.reduce((acc, i) => acc + (Number(i.valor) || 0), 0);
    const totalRec = receitas.reduce((acc, i) => acc + (Number(i.valor) || 0), 0);
    const saldo = totalRec - totalDesp;

    const items = [
      ...despesas.map((d) => ({ ...d, _kind: "despesa" })),
      ...receitas.map((r) => ({ ...r, _kind: "receita" })),
    ].sort((a, b) => {
      if (a.data === b.data) return (b.criadoEm || "").localeCompare(a.criadoEm || "");
      return (b.data || "").localeCompare(a.data || "");
    });

    const buscaEl = $("#pessoal-busca");
    if (buscaEl && document.activeElement !== buscaEl) buscaEl.value = pessoalBusca;
    const filtroEl = $("#pessoal-filtro-tipo");
    if (filtroEl) filtroEl.value = pessoalFiltroTipo;

    const busca = (pessoalBusca || "").trim().toLowerCase();
    let filtrados = items;
    if (busca) {
      filtrados = filtrados.filter((i) =>
        String(i.descricao || "")
          .toLowerCase()
          .includes(busca)
      );
    }
    if (pessoalFiltroTipo === "despesas") {
      filtrados = filtrados.filter((i) => i._kind === "despesa");
    } else if (pessoalFiltroTipo === "receitas") {
      filtrados = filtrados.filter((i) => i._kind === "receita");
    } else if (pessoalFiltroTipo === "fixas") {
      filtrados = filtrados.filter((i) => i._kind === "despesa" && i.fixaId);
    }
    if (pessoalFiltroCategoria) {
      filtrados = filtrados.filter(
        (i) =>
          i._kind === "despesa" &&
          (labelCategoriaPessoal(i) || "Sem categoria") === pessoalFiltroCategoria
      );
    }

    if (countEl) countEl.textContent = String(filtrados.length);

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
        const saldoClass =
          saldo > 0.004 ? "saldo--receber" : saldo < -0.004 ? "saldo--pagar" : "saldo--ok";
        totalBox.innerHTML = `
          <p class="mercado-total__label">${escapeHtml(tituloLista)} · ${escapeHtml(labelMes(mesId))}</p>
          <p class="mercado-total__valor ${saldoClass}">${formatMoney(saldo)}</p>`;
      }
    }

    if (resumoBox) {
      if (!items.length) {
        resumoBox.innerHTML = "";
      } else {
        let comparativoHtml = "";
        const prevId = mesAnteriorId(mesId);
        if (prevId) {
          const despPrev = (state.pessoais || []).filter(
            (p) => p.donoId === donoId && (p.data || "").slice(0, 7) === prevId
          );
          const recPrev = (state.pessoalReceitas || []).filter(
            (p) => p.donoId === donoId && (p.data || "").slice(0, 7) === prevId
          );
          if (despPrev.length || recPrev.length) {
            const totalDespPrev = despPrev.reduce((acc, i) => acc + (Number(i.valor) || 0), 0);
            const totalRecPrev = recPrev.reduce((acc, i) => acc + (Number(i.valor) || 0), 0);
            const saldoPrev = totalRecPrev - totalDespPrev;
            const deltaSaldo = saldo - saldoPrev;
            const deltaDesp = totalDesp - totalDespPrev;
            const sinalSaldo = deltaSaldo > 0.004 ? "+" : "";
            const sinalDesp = deltaDesp > 0.004 ? "+" : "";
            const pctDesp =
              totalDespPrev > 0.004
                ? ` (${sinalDesp}${((deltaDesp / totalDespPrev) * 100).toFixed(0)}%)`
                : "";
            const saldoClasse =
              deltaSaldo > 0.004
                ? "saldo--receber"
                : deltaSaldo < -0.004
                  ? "saldo--pagar"
                  : "saldo--ok";
            comparativoHtml = `
              <div class="card-grupo card-grupo--sm" style="grid-column:1/-1">
                <p class="card-grupo__nome">vs ${escapeHtml(labelMes(prevId))}</p>
                <p class="card-grupo__valor ${saldoClasse}" style="font-size:0.95rem">
                  Saldo ${sinalSaldo}${formatMoney(deltaSaldo)}
                </p>
                <p class="card-grupo__peso">Despesas ${sinalDesp}${formatMoney(deltaDesp)}${pctDesp}</p>
              </div>`;
          }
        }
        resumoBox.innerHTML = `
          <div class="grupos-grid">
            <div class="card-grupo">
              <p class="card-grupo__nome">Receitas</p>
              <p class="card-grupo__valor saldo--receber">${formatMoney(totalRec)}</p>
            </div>
            <div class="card-grupo">
              <p class="card-grupo__nome">Despesas</p>
              <p class="card-grupo__valor saldo--pagar">${formatMoney(totalDesp)}</p>
            </div>
            <div class="card-grupo">
              <p class="card-grupo__nome">Saldo</p>
              <p class="card-grupo__valor ${
                saldo > 0.004 ? "saldo--receber" : saldo < -0.004 ? "saldo--pagar" : "saldo--ok"
              }">${formatMoney(saldo)}</p>
            </div>
            ${comparativoHtml}
          </div>`;
      }
    }

    if (porCatBox) {
      if (!despesas.length) {
        porCatBox.innerHTML = "";
      } else {
        const mapa = {};
        despesas.forEach((item) => {
          const nome = labelCategoriaPessoal(item) || "Sem categoria";
          mapa[nome] = (mapa[nome] || 0) + (Number(item.valor) || 0);
        });
        const linhas = Object.entries(mapa).sort((a, b) => b[1] - a[1]);
        const filtroAtivo = pessoalFiltroCategoria
          ? `<button type="button" class="btn btn--ghost btn--sm btn-limpar-cat-pessoal" style="margin-top:0.45rem">
               Mostrando: ${escapeHtml(pessoalFiltroCategoria)} · limpar
             </button>`
          : `<p class="fieldset__hint" style="margin:0.4rem 0 0">Toque numa categoria para filtrar os lançamentos.</p>`;
        porCatBox.innerHTML = `
          <div class="card-resumo card-resumo--compacto">
            <p class="card-resumo__label">Despesas por categoria</p>
            <div class="grupos-grid grupos-grid--2" style="margin-top:0.55rem">
              ${linhas
                .map(([nome, valor]) => {
                  const ativo = pessoalFiltroCategoria === nome ? " card-grupo--ativo" : "";
                  return `
                <div class="card-grupo card-grupo--sm card-grupo--btn${ativo}" role="button" tabindex="0" data-categoria="${escapeHtml(nome)}" title="Filtrar por ${escapeHtml(nome)}">
                  <span class="card-grupo__nome">${escapeHtml(nome)}</span>
                  <span class="card-grupo__valor">${formatMoney(valor)}</span>
                </div>`;
                })
                .join("")}
            </div>
            ${filtroAtivo}
          </div>`;
      }
    }

    if (!filtrados.length) {
      box.innerHTML = "";
      empty.textContent = items.length
        ? "Nenhum lançamento com este filtro."
        : "Nenhuma despesa ou receita neste mês.";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    box.innerHTML = filtrados
      .map((item) => {
        const isRec = item._kind === "receita";
        const tipo = isRec ? labelTipoReceita(item) : labelTipoPessoal(item);
        const pag = labelPagamentoPessoal(item);
        const cat = isRec ? "" : ` · ${labelCategoriaPessoal(item)}`;
        const acoes = [];
        if (!isRec) {
          const fotoBtn = htmlBtnComprovante(item, {
            kind: "pessoal",
            canAdd: !!(podeEditar && !srcComprovante(item)),
            canRemove: !!(podeEditar && srcComprovante(item)),
          });
          if (fotoBtn) acoes.push(fotoBtn);
        }
        if (podeEditar) {
          acoes.push(
            `<button type="button" class="btn btn--edit btn--sm ${
              isRec ? "btn-editar-receita" : "btn-editar-pessoal"
            }" data-id="${item.id}" title="Editar" aria-label="Editar">✎</button>`
          );
          acoes.push(
            `<button type="button" class="btn btn--icon ${
              isRec ? "btn-excluir-receita" : "btn-excluir-pessoal"
            }" data-id="${item.id}" title="Excluir" aria-label="Excluir">×</button>`
          );
        }
        const valorClass = isRec ? "saldo--receber" : "saldo--pagar";
        const sinal = isRec ? "+" : "−";
        const dataCurta = formatDate(item.data);
        const detalhes = `${tipo}${cat} · ${pag}${
          item.criadoPorNome ? ` · ${item.criadoPorNome}` : ""
        }`;
        return `
      <article class="pessoal-linha ${isRec ? "pessoal-linha--receita" : ""}">
        <div class="pessoal-linha__texto">
          <p class="pessoal-linha__titulo">${escapeHtml(item.descricao)}</p>
          <p class="pessoal-linha__meta">${escapeHtml(dataCurta)} · ${escapeHtml(detalhes)}</p>
        </div>
        <p class="pessoal-linha__valor ${valorClass}">${sinal}${formatMoney(item.valor)}</p>
        <div class="pessoal-linha__acoes">${acoes.join("")}</div>
      </article>`;
      })
      .join("");

    wireComprovanteListEvents(box);

    box.querySelectorAll(".btn-editar-pessoal").forEach((btn) => {
      btn.addEventListener("click", () => iniciarEdicaoPessoal(btn.dataset.id));
    });
    box.querySelectorAll(".btn-editar-receita").forEach((btn) => {
      btn.addEventListener("click", () => iniciarEdicaoReceita(btn.dataset.id));
    });

    box.querySelectorAll(".btn-excluir-pessoal").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = (state.pessoais || []).find((p) => p.id === btn.dataset.id);
        if (!item || !podeEditarPessoalDe(item.donoId)) {
          return toast("Sem permissão para excluir nesta lista.");
        }
        if (!confirm(`Excluir despesa "${item.descricao}" (${formatMoney(item.valor)})?`)) return;
        if (item.comprovantePath) excluirComprovanteStorage(item.comprovantePath);
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
        toast("Despesa excluída.");
      });
    });

    box.querySelectorAll(".btn-excluir-receita").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = (state.pessoalReceitas || []).find((p) => p.id === btn.dataset.id);
        if (!item || !podeEditarPessoalDe(item.donoId)) {
          return toast("Sem permissão para excluir nesta lista.");
        }
        if (!confirm(`Excluir receita "${item.descricao}" (${formatMoney(item.valor)})?`)) return;
        const autor = usuarioAtual();
        state.pessoalReceitas = state.pessoalReceitas.filter((p) => p.id !== item.id);
        const outros = idsParticipantesPessoal(item.donoId, autor?.id);
        if (outros.length) {
          notificar({
            paraUserIds: outros,
            titulo: "Receita excluída",
            texto: `${autor?.nome || "Alguém"} excluiu a receita "${item.descricao}" (${formatMoney(item.valor)}).`,
            tipo: "pessoal",
            refId: item.id,
          });
        }
        saveState();
        updateNotifBadge();
        renderPessoal();
        toast("Receita excluída.");
      });
    });
  }

  function limparEdicaoPessoal() {
    editingPessoalId = null;
    limparComprovanteCampo("pessoal");
    const form = $("#form-pessoal");
    form?.reset();
    if ($("#pessoal-data")) $("#pessoal-data").value = todayISO();
    const donoId = pessoalDonoId || usuarioAtual()?.id;
    if (donoId) fillPessoalSelectsCadastro(donoId);
    setEditModeButtons(
      "#btn-salvar-pessoal",
      "#btn-cancelar-pessoal",
      false,
      "Salvar despesa",
      "Salvar alterações"
    );
  }

  function limparEdicaoReceita() {
    editingReceitaId = null;
    const form = $("#form-pessoal-receita");
    form?.reset();
    if ($("#receita-data")) $("#receita-data").value = todayISO();
    const donoId = pessoalDonoId || usuarioAtual()?.id;
    if (donoId) fillPessoalSelectsCadastro(donoId);
    setEditModeButtons(
      "#btn-salvar-receita",
      "#btn-cancelar-receita",
      false,
      "Salvar receita",
      "Salvar alterações"
    );
  }

  function iniciarEdicaoPessoal(id) {
    const item = (state.pessoais || []).find((p) => p.id === id);
    if (!item) return;
    if (!podeEditarPessoalDe(item.donoId)) return toast("Sem permissão.");
    editingReceitaId = null;
    limparEdicaoReceita();
    editingPessoalId = item.id;
    limparComprovanteCampo("pessoal");
    pessoalDonoId = item.donoId;
    fillPessoalListaSelect();
    fillPessoalSelectsCadastro(item.donoId);
    $("#pessoal-descricao").value = item.descricao || "";
    $("#pessoal-data").value = item.data || todayISO();
    $("#pessoal-tipo").value = item.tipoId || "";
    $("#pessoal-categoria").value = item.categoriaId || "";
    $("#pessoal-pagamento").value = item.pagamentoId || "";
    setMoneyInput("#pessoal-valor", item.valor);
    const src = srcComprovante(item);
    if (src) {
      comprovanteExistente.pessoal = {
        url: item.comprovanteUrl || null,
        path: item.comprovantePath || null,
        data: item.comprovanteData || null,
      };
      comprovanteRemovido.pessoal = false;
      mostrarPreviewComprovante("pessoal", src);
    }
    setEditModeButtons(
      "#btn-salvar-pessoal",
      "#btn-cancelar-pessoal",
      true,
      "Salvar despesa",
      "Salvar alterações"
    );
    const bloco = $("#pessoal-bloco-despesa");
    if (bloco) bloco.open = true;
    $$('#tab-pessoal details[data-acordeon="lancar"]').forEach((other) => {
      if (other !== bloco) other.open = false;
    });
    $("#form-pessoal")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function iniciarEdicaoReceita(id) {
    const item = (state.pessoalReceitas || []).find((p) => p.id === id);
    if (!item) return;
    if (!podeEditarPessoalDe(item.donoId)) return toast("Sem permissão.");
    editingPessoalId = null;
    limparEdicaoPessoal();
    editingReceitaId = item.id;
    pessoalDonoId = item.donoId;
    fillPessoalListaSelect();
    fillPessoalSelectsCadastro(item.donoId);
    $("#receita-descricao").value = item.descricao || "";
    $("#receita-data").value = item.data || todayISO();
    $("#receita-tipo").value = item.tipoId || "";
    $("#receita-pagamento").value = item.pagamentoId || "";
    setMoneyInput("#receita-valor", item.valor);
    setEditModeButtons(
      "#btn-salvar-receita",
      "#btn-cancelar-receita",
      true,
      "Salvar receita",
      "Salvar alterações"
    );
    const bloco = $("#pessoal-bloco-receita");
    if (bloco) bloco.open = true;
    $$('#tab-pessoal details[data-acordeon="lancar"]').forEach((other) => {
      if (other !== bloco) other.open = false;
    });
    $("#form-pessoal-receita")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initPessoal() {
    const dataEl = $("#pessoal-data");
    if (dataEl) dataEl.value = todayISO();
    const dataRec = $("#receita-data");
    if (dataRec) dataRec.value = todayISO();

    $("#pessoal-por-categoria")?.addEventListener("click", (e) => {
      const limpar = e.target.closest(".btn-limpar-cat-pessoal");
      if (limpar) {
        pessoalFiltroCategoria = "";
        renderPessoal();
        toast("Filtro de categoria removido.");
        return;
      }
      const card = e.target.closest(".card-grupo--btn");
      if (!card) return;
      const cat = card.getAttribute("data-categoria") || "";
      if (!cat) return;
      if (pessoalFiltroCategoria === cat) {
        pessoalFiltroCategoria = "";
        toast("Filtro de categoria removido.");
      } else {
        pessoalFiltroCategoria = cat;
        if (pessoalFiltroTipo === "receitas") {
          pessoalFiltroTipo = "despesas";
          const sel = $("#pessoal-filtro-tipo");
          if (sel) sel.value = "despesas";
        }
        toast(`Filtrando: ${cat}`);
      }
      renderPessoal();
      $("#lista-pessoal")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    $("#pessoal-por-categoria")?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest(".card-grupo--btn");
      if (!card) return;
      e.preventDefault();
      card.click();
    });

    // Um menu aberto por vez (despesa / receita / cadastros / compartilhar)
    $$('#tab-pessoal details[data-acordeon="lancar"]').forEach((el) => {
      el.addEventListener("toggle", () => {
        if (!el.open) return;
        $$('#tab-pessoal details[data-acordeon="lancar"]').forEach((other) => {
          if (other !== el) other.open = false;
        });
      });
    });

    $("#pessoal-lista")?.addEventListener("change", (e) => {
      pessoalDonoId = e.target.value || usuarioAtualId;
      limparEdicaoPessoal();
      limparEdicaoReceita();
      limparEdicaoFixa(pessoalDonoId);
      renderPessoal();
    });

    $("#pessoal-mes")?.addEventListener("change", (e) => {
      pessoalMesId = e.target.value || currentMonthId();
      pessoalFiltroCategoria = "";
      renderPessoal();
    });

    $("#pessoal-busca")?.addEventListener("input", (e) => {
      pessoalBusca = e.target.value || "";
      renderPessoal();
    });

    $("#pessoal-filtro-tipo")?.addEventListener("change", (e) => {
      pessoalFiltroTipo = e.target.value || "todos";
      if (pessoalFiltroTipo === "receitas") pessoalFiltroCategoria = "";
      renderPessoal();
    });

    $("#btn-cancelar-pessoal")?.addEventListener("click", () => {
      limparEdicaoPessoal();
      toast("Edição cancelada.");
    });

    $("#btn-cancelar-receita")?.addEventListener("click", () => {
      limparEdicaoReceita();
      toast("Edição cancelada.");
    });

    $("#btn-cancelar-fixa")?.addEventListener("click", () => {
      limparEdicaoFixa(pessoalDonoId || usuarioAtual()?.id);
      toast("Edição cancelada.");
    });

    $("#btn-add-pessoal-tipo")?.addEventListener("click", () =>
      adicionarCadastroPessoal("pessoalTipos", "#pessoal-tipo-nome", "o tipo de despesa")
    );
    $("#btn-add-pessoal-tipo-rec")?.addEventListener("click", () =>
      adicionarCadastroPessoal("pessoalTiposReceita", "#pessoal-tipo-rec-nome", "o tipo de receita")
    );
    $("#btn-add-pessoal-cat")?.addEventListener("click", () =>
      adicionarCadastroPessoal("pessoalCategorias", "#pessoal-cat-nome", "a categoria")
    );
    $("#btn-add-pessoal-pag")?.addEventListener("click", () =>
      adicionarCadastroPessoal("pessoalPagamentos", "#pessoal-pag-nome", "a forma")
    );

    ["#pessoal-tipo-nome", "#pessoal-tipo-rec-nome", "#pessoal-cat-nome", "#pessoal-pag-nome"].forEach(
      (sel) => {
        $(sel)?.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (sel.includes("tipo-rec")) $("#btn-add-pessoal-tipo-rec")?.click();
          else if (sel.includes("tipo")) $("#btn-add-pessoal-tipo")?.click();
          else if (sel.includes("cat")) $("#btn-add-pessoal-cat")?.click();
          else $("#btn-add-pessoal-pag")?.click();
        });
      }
    );

    $("#form-pessoal")?.addEventListener("submit", async (e) => {
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
      const valor = parseMoneyInput($("#pessoal-valor").value);
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

      const campos = {
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
      };

      if (editingPessoalId) {
        const existente = (state.pessoais || []).find((p) => p.id === editingPessoalId);
        if (!existente || !podeEditarPessoalDe(existente.donoId)) {
          limparEdicaoPessoal();
          return toast("Despesa não encontrada ou sem permissão.");
        }
        Object.assign(existente, campos);
        try {
          await aplicarComprovanteNoItem(existente, "pessoal");
        } catch (err) {
          console.warn(err);
          return toast("Não foi possível enviar a foto.");
        }
        const outros = idsParticipantesPessoal(existente.donoId, u.id);
        if (outros.length) {
          notificar({
            paraUserIds: outros,
            titulo: "Despesa pessoal editada",
            texto: `${u.nome} editou "${descricao}" (${categoria.nome}) para ${formatMoney(valor)}.`,
            tipo: "pessoal",
            refId: existente.id,
          });
        }
        saveState();
        updateNotifBadge();
        limparEdicaoPessoal();
        pessoalDonoId = existente.donoId;
        pessoalMesId = data.slice(0, 7);
        renderPessoal();
        toast("Despesa atualizada.");
        return;
      }

      const item = {
        id: uid(),
        donoId: dono.id,
        donoNome: dono.nome,
        ...campos,
        criadoPorId: u.id,
        criadoPorNome: u.nome,
        criadoEm: new Date().toISOString(),
      };
      try {
        await aplicarComprovanteNoItem(item, "pessoal");
      } catch (err) {
        console.warn(err);
        return toast("Não foi possível enviar a foto.");
      }
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
      limparComprovanteCampo("pessoal");
      $("#pessoal-data").value = todayISO();
      pessoalDonoId = dono.id;
      pessoalMesId = data.slice(0, 7);
      renderPessoal();
      toast("Despesa salva.");
    });

    $("#form-pessoal-receita")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const u = usuarioAtual();
      if (!u) return toast("Faça login.");
      const donoId = pessoalDonoId || u.id;
      if (!podeEditarPessoalDe(donoId)) {
        return toast("Sem permissão para lançar nesta lista.");
      }
      const dono = state.pessoas.find((p) => p.id === donoId) || u;
      const descricao = $("#receita-descricao").value.trim();
      const data = $("#receita-data").value;
      const tipoId = $("#receita-tipo").value;
      const pagamentoId = $("#receita-pagamento").value;
      const valor = parseMoneyInput($("#receita-valor").value);
      const tipo = (state.pessoalTiposReceita || []).find(
        (t) => t.id === tipoId && t.donoId === donoId
      );
      const pagamento = (state.pessoalPagamentos || []).find(
        (p) => p.id === pagamentoId && p.donoId === donoId
      );

      if (!descricao || !data || !(valor > 0)) {
        return toast("Preencha descrição, data e valor da receita.");
      }
      if (!tipo || !pagamento) {
        return toast("Selecione tipo de receita e forma de recebimento.");
      }

      const campos = {
        descricao,
        data,
        tipoId: tipo.id,
        tipoNome: tipo.nome,
        pagamentoId: pagamento.id,
        pagamentoNome: pagamento.nome,
        pagamento: pagamento.nome,
        valor,
      };

      if (editingReceitaId) {
        const existente = (state.pessoalReceitas || []).find((p) => p.id === editingReceitaId);
        if (!existente || !podeEditarPessoalDe(existente.donoId)) {
          limparEdicaoReceita();
          return toast("Receita não encontrada ou sem permissão.");
        }
        Object.assign(existente, campos);
        const outros = idsParticipantesPessoal(existente.donoId, u.id);
        if (outros.length) {
          notificar({
            paraUserIds: outros,
            titulo: "Receita editada",
            texto: `${u.nome} editou a receita "${descricao}" (${tipo.nome}) para ${formatMoney(valor)}.`,
            tipo: "pessoal",
            refId: existente.id,
          });
        }
        saveState();
        updateNotifBadge();
        limparEdicaoReceita();
        pessoalDonoId = existente.donoId;
        pessoalMesId = data.slice(0, 7);
        renderPessoal();
        toast("Receita atualizada.");
        return;
      }

      const item = {
        id: uid(),
        donoId: dono.id,
        donoNome: dono.nome,
        ...campos,
        criadoPorId: u.id,
        criadoPorNome: u.nome,
        criadoEm: new Date().toISOString(),
      };
      if (!Array.isArray(state.pessoalReceitas)) state.pessoalReceitas = [];
      state.pessoalReceitas.unshift(item);

      const outros = idsParticipantesPessoal(dono.id, u.id);
      if (outros.length) {
        notificar({
          paraUserIds: outros,
          titulo: "Nova receita",
          texto: `${u.nome} lançou receita "${descricao}" (${tipo.nome}) de ${formatMoney(valor)}.`,
          tipo: "pessoal",
          refId: item.id,
        });
      }

      saveState();
      updateNotifBadge();
      e.target.reset();
      $("#receita-data").value = todayISO();
      pessoalDonoId = dono.id;
      pessoalMesId = data.slice(0, 7);
      renderPessoal();
      toast("Receita salva.");
    });

    $("#form-pessoal-fixa")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const u = usuarioAtual();
      if (!u) return toast("Faça login.");
      const donoId = pessoalDonoId || u.id;
      if (!podeEditarPessoalDe(donoId)) {
        return toast("Sem permissão para cadastrar nesta lista.");
      }
      const descricao = $("#fixa-descricao").value.trim();
      const valor = parseMoneyInput($("#fixa-valor").value);
      const tipoId = $("#fixa-tipo").value;
      const categoriaId = $("#fixa-categoria").value;
      const diaRaw = $("#fixa-dia").value;
      const diaVencimento = diaRaw === "" ? null : Number(diaRaw);
      const tipo = (state.pessoalTipos || []).find((t) => t.id === tipoId && t.donoId === donoId);
      const categoria = (state.pessoalCategorias || []).find(
        (c) => c.id === categoriaId && c.donoId === donoId
      );

      if (!descricao || !(valor > 0)) {
        return toast("Preencha descrição e valor da despesa fixa.");
      }
      if (!tipo || !categoria) {
        return toast("Selecione tipo e categoria.");
      }
      if (
        diaVencimento != null &&
        (!Number.isFinite(diaVencimento) || diaVencimento < 1 || diaVencimento > 31)
      ) {
        return toast("Dia do vencimento deve ser entre 1 e 31.");
      }

      if (editingFixaId) {
        const existente = (state.pessoalDespesasFixas || []).find(
          (f) => f.id === editingFixaId && f.donoId === donoId
        );
        if (!existente) {
          limparEdicaoFixa(donoId);
          return toast("Despesa fixa não encontrada.");
        }
        existente.descricao = descricao;
        existente.valor = valor;
        existente.tipoId = tipo.id;
        existente.tipoNome = tipo.nome;
        existente.categoriaId = categoria.id;
        existente.categoriaNome = categoria.nome;
        existente.diaVencimento = diaVencimento || null;
        saveState();
        limparEdicaoFixa(donoId);
        renderPessoal();
        toast("Despesa fixa atualizada.");
        return;
      }

      const item = {
        id: uid(),
        donoId,
        descricao,
        valor,
        tipoId: tipo.id,
        tipoNome: tipo.nome,
        categoriaId: categoria.id,
        categoriaNome: categoria.nome,
        diaVencimento: diaVencimento || null,
        ativo: true,
        criadoEm: new Date().toISOString(),
      };
      if (!Array.isArray(state.pessoalDespesasFixas)) state.pessoalDespesasFixas = [];
      state.pessoalDespesasFixas.push(item);
      saveState();
      e.target.reset();
      fillPessoalSelectsCadastro(donoId);
      renderPessoal();
      toast("Despesa fixa cadastrada.");
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
      const valor = parseMoneyInput($("#pendencia-valor").value);
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

  function adicionarLinhaCompra(pessoaId = "", valor = "", compraMeta = null) {
    const box = $("#vaquinha-compras");
    const row = document.createElement("div");
    row.className = "compra-row";
    row.dataset.compraId = compraMeta?.id || uid();
    row._pendingBlob = null;
    row._fotoRemovida = false;
    row._fotoExistente = null;
    if (compraMeta && (compraMeta.comprovanteUrl || compraMeta.comprovanteData)) {
      row._fotoExistente = {
        url: compraMeta.comprovanteUrl || null,
        path: compraMeta.comprovantePath || null,
        data: compraMeta.comprovanteData || null,
        provider: compraMeta.comprovanteProvider || null,
      };
    }
    const valorFmt =
      valor === "" || valor == null || !(Number(valor) >= 0)
        ? ""
        : formatMoneyDigits(String(Math.round(Number(valor) * 100)));
    row.innerHTML = `
      <div class="compra-row__main">
        <select class="compra-pessoa" required>${opcoesPessoasHtml(pessoaId)}</select>
        <input type="text" class="compra-valor input-money" inputmode="numeric" placeholder="0,00" value="${valorFmt}" required />
        <button type="button" class="btn btn--icon btn-remover-compra" title="Remover" aria-label="Remover">×</button>
      </div>
      <div class="compra-row__foto">
        <span class="compra-row__foto-label">Notinha</span>
        <button type="button" class="btn btn--secondary btn--sm compra-foto-cam">📷</button>
        <button type="button" class="btn btn--secondary btn--sm compra-foto-gal">🖼</button>
        <button type="button" class="btn btn--ghost btn--sm compra-foto-limpar hidden">Remover</button>
        <input type="file" class="file-input-visually-hidden compra-foto-input-cam" accept="image/*" capture="environment" />
        <input type="file" class="file-input-visually-hidden compra-foto-input-gal" accept="image/*" />
        <div class="compra-foto-preview comprovante-preview hidden"><img alt="Notinha da compra" /></div>
      </div>
    `;
    box.appendChild(row);
    const valorEl = row.querySelector(".compra-valor");
    bindMoneyInput(valorEl);
    row.querySelector(".compra-pessoa").addEventListener("change", atualizarPreviewVaquinha);
    valorEl.addEventListener("input", atualizarPreviewVaquinha);
    row.querySelector(".btn-remover-compra").addEventListener("click", () => {
      if ($$("#vaquinha-compras .compra-row").length <= 1) {
        return toast("Mantenha ao menos uma compra.");
      }
      row.remove();
      atualizarPreviewVaquinha();
    });

    const fileCam = row.querySelector(".compra-foto-input-cam");
    const fileGal = row.querySelector(".compra-foto-input-gal");
    const preview = row.querySelector(".compra-foto-preview");
    const previewImg = preview?.querySelector("img");
    const btnLimpar = row.querySelector(".compra-foto-limpar");

    const mostrarPreview = (src) => {
      if (!preview || !previewImg || !src) return;
      previewImg.src = src;
      preview.classList.remove("hidden");
      btnLimpar?.classList.remove("hidden");
    };
    const limparPreview = () => {
      if (previewImg) previewImg.removeAttribute("src");
      preview?.classList.add("hidden");
      btnLimpar?.classList.add("hidden");
    };

    const processar = async (fileEl) => {
      const chosen = fileEl.files?.[0];
      if (!chosen) {
        toast("Nenhuma foto recebida. Tente de novo ou use Galeria.");
        return;
      }
      try {
        toast("Processando notinha…");
        const blob = await compressImageFile(chosen);
        row._pendingBlob = blob;
        row._fotoRemovida = false;
        mostrarPreview(URL.createObjectURL(blob));
        toast("Notinha pronta. Salve a vaquinha para enviar.");
      } catch (err) {
        console.warn(err);
        row._pendingBlob = null;
        toast(err?.message || "Não foi possível processar a imagem.");
      } finally {
        try {
          fileEl.value = "";
        } catch {
          /* ignore */
        }
      }
    };

    row.querySelector(".compra-foto-cam")?.addEventListener("click", (e) => {
      e.preventDefault();
      fileCam?.click();
    });
    row.querySelector(".compra-foto-gal")?.addEventListener("click", (e) => {
      e.preventDefault();
      fileGal?.click();
    });
    fileCam?.addEventListener("change", () => processar(fileCam));
    fileGal?.addEventListener("change", () => processar(fileGal));
    btnLimpar?.addEventListener("click", () => {
      row._pendingBlob = null;
      row._fotoRemovida = true;
      limparPreview();
      toast("Notinha removida desta compra.");
    });

    const srcExistente = srcComprovanteCompra(compraMeta);
    if (srcExistente) mostrarPreview(srcExistente);
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
      const valor = parseMoneyInput(row.querySelector(".compra-valor").value);
      const pessoa = state.pessoas.find((p) => p.id === pessoaId);
      if (pessoa && valor > 0) {
        const compra = {
          id: row.dataset.compraId || uid(),
          pessoaId,
          nome: pessoa.nome,
          valor,
        };
        row.dataset.compraId = compra.id;
        if (!row._fotoRemovida && row._fotoExistente) {
          if (row._fotoExistente.url) {
            compra.comprovanteUrl = row._fotoExistente.url;
            compra.comprovantePath = row._fotoExistente.path || "";
            compra.comprovanteProvider = row._fotoExistente.provider || "imgbb";
          } else if (row._fotoExistente.data) {
            compra.comprovanteData = row._fotoExistente.data;
            compra.comprovanteProvider = "data";
          }
        }
        compras.push(compra);
      }
    });
    return compras;
  }

  async function aplicarFotosNasCompras(compras) {
    if (!Array.isArray(compras) || !compras.length) return;
    const rows = $$("#vaquinha-compras .compra-row");
    for (const compra of compras) {
      const row = rows.find((r) => r.dataset.compraId === compra.id);
      if (!row?._pendingBlob) continue;
      if (!imgbbPronto() && !storagePronto()) {
        toast("Configure a chave ImgBB em js/firebase-config.js para salvar as notinhas.");
        continue;
      }
      toast(`Enviando notinha de ${compra.nome}…`);
      const oldPath = compra.comprovantePath || null;
      const result = await uploadComprovante(row._pendingBlob, compra.id);
      if (result.url) {
        compra.comprovanteUrl = result.url;
        compra.comprovantePath = result.path || "";
        compra.comprovanteProvider = result.provider || "imgbb";
        delete compra.comprovanteData;
      } else if (result.data) {
        compra.comprovanteData = result.data;
        compra.comprovanteProvider = "data";
        delete compra.comprovanteUrl;
        delete compra.comprovantePath;
      }
      if (oldPath && oldPath !== compra.comprovantePath) {
        excluirComprovanteRemoto(oldPath);
      }
      row._pendingBlob = null;
      row._fotoExistente = {
        url: compra.comprovanteUrl || null,
        path: compra.comprovantePath || null,
        data: compra.comprovanteData || null,
        provider: compra.comprovanteProvider || null,
      };
      row._fotoRemovida = false;
    }
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

  /**
   * Liga um grupo da casa a um usuário cadastrado (para misturar com vaquinha/entre nós).
   * Usa grupo.pessoaId se existir; senão tenta casar pelo nome no texto do grupo.
   */
  function pessoaRepresentanteDoGrupo(grupo) {
    if (!grupo) return null;
    if (grupo.pessoaId) {
      const ligada = (state.pessoas || []).find((p) => p.id === grupo.pessoaId);
      if (ligada) return ligada;
    }
    const gNome = String(grupo.nome || "").trim().toLowerCase();
    if (!gNome) return null;
    const candidatos = [...(state.pessoas || [])]
      .filter((p) => p?.nome)
      .sort((a, b) => String(b.nome).length - String(a.nome).length);
    for (const p of candidatos) {
      const n = String(p.nome).trim().toLowerCase();
      if (!n || n.length < 2) continue;
      if (gNome === n) return p;
      // "paulo / esposa / filhos" → casa com "paulo"
      if (gNome.startsWith(`${n} `) || gNome.startsWith(`${n}/`) || gNome.startsWith(`${n} /`)) {
        return p;
      }
      // token entre barras: "mãe / joão / avô"
      const tokens = gNome.split(/[/|,;]+/).map((t) => t.trim()).filter(Boolean);
      if (tokens.some((t) => t === n || t.startsWith(`${n} `))) return p;
    }
    return null;
  }

  /** Converte saldo de grupos (mercado/despesas) para o mesmo espaço de IDs das pessoas. */
  function converterSaldosGruposParaPessoas(saldosGrupos) {
    return (saldosGrupos || []).map((s) => {
      const grupo =
        (state.grupos || []).find((g) => g.id === s.id) || { id: s.id, nome: s.nome };
      const pessoa = pessoaRepresentanteDoGrupo(grupo);
      if (pessoa) {
        return {
          id: pessoa.id,
          nome: pessoa.nome,
          pagou: Number(s.pagou) || 0,
          cota: Number(s.cota) || 0,
          saldo: Number(s.saldo) || 0,
        };
      }
      return {
        id: `grupo:${s.id}`,
        nome: s.nome || "Grupo",
        pagou: Number(s.pagou) || 0,
        cota: Number(s.cota) || 0,
        saldo: Number(s.saldo) || 0,
      };
    });
  }

  function calcularSaldosEncontro(mesId, opts = {}) {
    const useCasa = !!opts.casa;
    const useVaq = !!opts.vaquinha;
    const usePend = !!opts.pendencias;
    const partes = [];

    if (useCasa) {
      const casa = state.lancamentos.filter(
        (l) => l.mesId === mesId && (l.tipo === "mercado" || l.tipo === "despesa")
      );
      partes.push({
        key: "casa",
        label: "Mercado",
        saldos: converterSaldosGruposParaPessoas(calcularSaldosGrupos(casa)),
      });
    }
    if (useVaq) {
      partes.push({
        key: "vaquinha",
        label: "Vaquinha",
        saldos: calcularSaldosPessoasVaquinha(mesId),
      });
    }
    if (usePend) {
      partes.push({
        key: "pendencias",
        label: "Entre nós",
        saldos: calcularSaldosPendenciasMes(mesId),
      });
    }

    const merged = mergeSaldosPessoas(partes.map((p) => p.saldos));
    const EPS = 0.005;
    return merged.map((s) => {
      const detalheOrigens = [];
      partes.forEach((p) => {
        const row = (p.saldos || []).find((x) => x.id === s.id);
        const saldo = Number(row?.saldo) || 0;
        if (Math.abs(saldo) > EPS) {
          detalheOrigens.push({ key: p.key, label: p.label, saldo });
        }
      });
      return { ...s, detalheOrigens };
    });
  }

  function htmlDetalheOrigensSaldo(s) {
    const det = Array.isArray(s?.detalheOrigens) ? s.detalheOrigens : [];
    if (det.length < 1) return "";
    const net = Number(s.saldo) || 0;
    const partes = det.map((d) => {
      const v = Math.abs(Number(d.saldo) || 0);
      const mesmoLado =
        Math.abs(net) < 0.005 || (net > 0 && d.saldo > 0) || (net < 0 && d.saldo < 0);
      if (mesmoLado) {
        return `${formatMoney(v)} de ${escapeHtml(d.label)}`;
      }
      const lado = d.saldo > 0 ? "a receber" : "a pagar";
      return `${formatMoney(v)} ${lado} (${escapeHtml(d.label)})`;
    });
    return `<p class="card-grupo__origens">${partes.join(" · ")}</p>`;
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

  function htmlBlocoAcerto({
    titulo,
    meta,
    saldos,
    transfers,
    vazio,
    mostrarCabecalho = true,
    mesId = null,
    escopo = null,
  }) {
    const saldosAtivos = filtrarSaldosAtivos(saldos);
    const transfersAtivas = (transfers || []).filter((t) => Number(t.valor) > 0.005);
    const comQuitacao = Boolean(mesId && escopo);
    const pendentes = [];
    const quitadas = [];
    transfersAtivas.forEach((t) => {
      if (comQuitacao && quitacaoExiste(mesId, escopo, t)) quitadas.push(t);
      else pendentes.push(t);
    });

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
            ${htmlDetalheOrigensSaldo(s)}
            <p class="card-grupo__peso">Cota ${formatMoney(s.cota)} · Pagou ${formatMoney(s.pagou)}</p>
          </div>`;
          })
          .join("")}
      </div>`
      : "";

    const renderTransfer = (t, quitada) => {
      const acao = !comQuitacao
        ? ""
        : quitada
          ? `<button type="button" class="btn btn--ghost btn--sm btn-desfazer-quitacao no-print"
               data-mes="${escapeHtml(mesId)}" data-escopo="${escapeHtml(escopo)}"
               data-de="${escapeHtml(t.deId)}" data-para="${escapeHtml(t.paraId)}"
               data-valor="${Number(t.valor)}" data-denome="${escapeHtml(t.deNome)}"
               data-paranome="${escapeHtml(t.paraNome)}">Desfazer</button>
             <span class="badge badge--aberto">Quitado</span>`
          : `<button type="button" class="btn btn--primary btn--sm btn-marcar-quitacao no-print"
               data-mes="${escapeHtml(mesId)}" data-escopo="${escapeHtml(escopo)}"
               data-de="${escapeHtml(t.deId)}" data-para="${escapeHtml(t.paraId)}"
               data-valor="${Number(t.valor)}" data-denome="${escapeHtml(t.deNome)}"
               data-paranome="${escapeHtml(t.paraNome)}">Marcar pago</button>`;
      return `
          <div class="acerto-item ${quitada ? "acerto-item--quitado" : ""}">
            <p class="acerto-item__fluxo">
              <strong>${escapeHtml(t.deNome)}</strong>
              <span class="acerto-item__seta" aria-hidden="true">→</span>
              <strong>${escapeHtml(t.paraNome)}</strong>
            </p>
            <p class="acerto-item__valor">${formatMoney(t.valor)}</p>
            <div class="acerto-item__acoes">${acao}</div>
          </div>`;
    };

    let transfersHtml = "";
    if (pendentes.length) {
      transfersHtml += `
      <div class="acerto-lista">
        <p class="acerto-lista__titulo">Quem passa pra quem</p>
        ${pendentes.map((t) => renderTransfer(t, false)).join("")}
      </div>`;
    } else if (transfersAtivas.length && quitadas.length) {
      transfersHtml += `<p class="fieldset__hint" style="margin:0.75rem 0 0">Todas as transferências deste bloco já foram quitadas.</p>`;
    } else if (!transfersAtivas.length) {
      transfersHtml += `<p class="fieldset__hint" style="margin:0.75rem 0 0">Todos quitados — nenhuma transferência.</p>`;
    }

    if (quitadas.length) {
      transfersHtml += `
      <div class="acerto-lista acerto-lista--quitadas">
        <p class="acerto-lista__titulo">Já quitadas</p>
        ${quitadas.map((t) => renderTransfer(t, true)).join("")}
      </div>`;
    }

    return `${cabecalho}${saldosHtml}${transfersHtml}`;
  }

  function marcarTransferenciaPaga(mesId, escopo, t) {
    const u = usuarioAtual();
    if (!u) return toast("Faça login.");
    if (!mesId || !escopo || !t) return;
    if (quitacaoExiste(mesId, escopo, t)) return toast("Já está quitada.");
    if (!Array.isArray(state.encontrosQuitacoes)) state.encontrosQuitacoes = [];
    state.encontrosQuitacoes.push({
      id: uid(),
      mesId,
      escopo,
      deId: t.deId,
      deNome: t.deNome,
      paraId: t.paraId,
      paraNome: t.paraNome,
      valor: Number(t.valor),
      pagoEm: new Date().toISOString(),
      pagoPorId: u.id,
      pagoPorNome: u.nome,
    });

    if (escopo === "pessoas" || escopo === "encontro") {
      const match = (state.pendencias || []).find(
        (p) =>
          p &&
          p.status === "pendente" &&
          (p.data || "").slice(0, 7) === mesId &&
          p.devedorId === t.deId &&
          p.credorId === t.paraId &&
          Math.abs(Number(p.valor) - Number(t.valor)) < 0.02
      );
      if (match) {
        match.status = "pago";
        match.pagoEm = new Date().toISOString();
        match.pagoPorId = u.id;
        match.pagoPorNome = u.nome;
      }
    }

    saveState();
    updateNotifBadge();
    renderEncontro();
    renderVaquinhaLista();
    renderPendencias();
    renderRelatorio();
    toast("Transferência marcada como paga.");
  }

  function desfazerTransferenciaPaga(mesId, escopo, t) {
    if (!usuarioAtual()) return toast("Faça login.");
    if (!mesId || !escopo || !t) return;
    const fp = fingerprintTransferencia(mesId, escopo, t.deId, t.paraId, t.valor);
    state.encontrosQuitacoes = (state.encontrosQuitacoes || []).filter(
      (q) =>
        fingerprintTransferencia(q.mesId, q.escopo, q.deId, q.paraId, q.valor) !== fp
    );
    saveState();
    renderEncontro();
    renderVaquinhaLista();
    renderRelatorio();
    toast("Quitação desfeita.");
  }

  function bindQuitacaoButtons(root) {
    root?.querySelectorAll(".btn-marcar-quitacao").forEach((btn) => {
      btn.addEventListener("click", () => {
        marcarTransferenciaPaga(btn.dataset.mes, btn.dataset.escopo, {
          deId: btn.dataset.de,
          deNome: btn.dataset.denome,
          paraId: btn.dataset.para,
          paraNome: btn.dataset.paranome,
          valor: Number(btn.dataset.valor),
        });
      });
    });
    root?.querySelectorAll(".btn-desfazer-quitacao").forEach((btn) => {
      btn.addEventListener("click", () => {
        desfazerTransferenciaPaga(btn.dataset.mes, btn.dataset.escopo, {
          deId: btn.dataset.de,
          deNome: btn.dataset.denome,
          paraId: btn.dataset.para,
          paraNome: btn.dataset.paranome,
          valor: Number(btn.dataset.valor),
        });
      });
    });
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
        const semSenha = pessoaPrecisaDefinirSenha(p);
        const meta = [
          adminUser ? "admin" : null,
          voce ? "você" : null,
          semSenha ? "sem senha" : "com senha",
        ]
          .filter(Boolean)
          .join(" · ");
        const podeRemover = isAdmin() && !adminUser && !voce;
        const podeReset = isAdmin() && !semSenha;
        const podeDefinir = semSenha && (voce || isAdmin());
        return `
      <li class="lista-pessoas__item">
        <span>${escapeHtml(p.nome)}${meta ? ` <span class="detalhe">(${meta})</span>` : ""}</span>
        <span class="lista-pessoas__acoes">
          ${
            podeDefinir
              ? `<button type="button" class="btn btn--secondary btn--sm btn-definir-senha" data-id="${p.id}" title="Definir senha">Definir senha</button>`
              : ""
          }
          ${
            podeReset
              ? `<button type="button" class="btn btn--ghost btn--sm btn-reset-senha" data-id="${p.id}" title="Resetar senha">Reset senha</button>`
              : ""
          }
          ${
            podeRemover
              ? `<button type="button" class="btn btn--icon btn-excluir-pessoa" data-id="${p.id}" title="Remover">×</button>`
              : ""
          }
        </span>
      </li>`;
      })
      .join("");

    lista.querySelectorAll(".btn-definir-senha").forEach((btn) => {
      btn.addEventListener("click", () => abrirModalDefinirSenha(btn.dataset.id));
    });

    lista.querySelectorAll(".btn-reset-senha").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!isAdmin()) return toast("Somente o admin pode resetar senhas.");
        const pessoa = state.pessoas.find((p) => p.id === btn.dataset.id);
        if (!pessoa) return;
        if (
          !confirm(
            `Resetar a senha de ${pessoa.nome}?\nNo próximo login a pessoa deverá criar uma senha nova.`
          )
        ) {
          return;
        }
        resetarSenhaPessoa(pessoa);
        saveState();
        renderPessoasLista();
        renderLoginUI();
        toast(`Senha de ${pessoa.nome} resetada.`);
        if (pessoa.id === usuarioAtualId) {
          forcarTelaLoginParaDefinirSenha(pessoa);
        }
      });
    });

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
      renderVaquinhaLista();
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
    renderVaquinhaLista();
    updateMesStatus();
  }

  function limparEdicaoVaquinha() {
    editingVaquinhaId = null;
    limparComprovanteCampo("vaquinha");
    const form = $("#form-vaquinha");
    form?.reset();
    if ($("#vaquinha-data")) $("#vaquinha-data").value = todayISO();
    if ($("#vaquinha-compras")) $("#vaquinha-compras").innerHTML = "";
    const legend = $("#vaquinha-form-legend");
    if (legend) legend.textContent = "Nova vaquinha";
    setEditModeButtons(
      "#btn-salvar-vaquinha",
      "#btn-cancelar-vaquinha",
      false,
      "Salvar vaquinha",
      "Salvar alterações"
    );
    renderVaquinhaUI();
  }

  function iniciarEdicaoVaquinha(id) {
    const item = state.lancamentos.find((l) => l.id === id && l.tipo === "vaquinha");
    if (!item) return;
    if (item.lancadoPorId !== usuarioAtualId && !isAdmin()) {
      return toast("Só quem lançou (ou o admin) pode editar.");
    }
    if (!mesEstaAberto(item.mesId)) return toast("Só é possível editar no mês aberto.");

    editingVaquinhaId = item.id;
    limparComprovanteCampo("vaquinha");

    if ($("#vaquinha-descricao")) $("#vaquinha-descricao").value = item.descricao || "";
    if ($("#vaquinha-data")) $("#vaquinha-data").value = item.data || todayISO();

    const boxCompras = $("#vaquinha-compras");
    if (boxCompras) {
      boxCompras.innerHTML = "";
      const compras = Array.isArray(item.compras) ? item.compras : [];
      if (compras.length) {
        compras.forEach((c) => adicionarLinhaCompra(c.pessoaId, c.valor, c));
      } else {
        adicionarLinhaCompra();
      }
    }

    renderVaquinhaUI();

    const pesosPorId = {};
    (item.participantes || []).forEach((p) => {
      if (p?.pessoaId) pesosPorId[p.pessoaId] = p.peso || 1;
    });
    $$("#vaquinha-participantes .chk-participante").forEach((chk) => {
      const peso = pesosPorId[chk.dataset.id];
      const marcado = peso != null;
      chk.checked = marcado;
      const sel = $(`#vaquinha-participantes .sel-peso[data-id="${chk.dataset.id}"]`);
      if (sel) {
        sel.disabled = !marcado;
        if (marcado) sel.value = String(Math.min(4, Math.max(1, Number(peso) || 1)));
        else sel.value = "1";
      }
    });
    atualizarPreviewVaquinha();

    const src = srcComprovante(item);
    if (src) {
      comprovanteExistente.vaquinha = {
        url: item.comprovanteUrl || null,
        path: item.comprovantePath || null,
        data: item.comprovanteData || null,
      };
      comprovanteRemovido.vaquinha = false;
      mostrarPreviewComprovante("vaquinha", src);
    }

    const legend = $("#vaquinha-form-legend");
    if (legend) legend.textContent = "Editar vaquinha";
    setEditModeButtons(
      "#btn-salvar-vaquinha",
      "#btn-cancelar-vaquinha",
      true,
      "Salvar vaquinha",
      "Salvar alterações"
    );
    updateMesStatus();
    $("#form-vaquinha")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderVaquinhaLista() {
    const box = $("#lista-vaquinha");
    const empty = $("#empty-vaquinha");
    const totalBox = $("#vaquinha-total");
    const countEl = $("#vaquinha-count");
    if (!box || !empty) return;

    const mesId = state.mesAtual || mesSelecionado;
    const podeExcluirMes = mesEstaAberto(mesId);
    const items = state.lancamentos
      .filter((l) => l.tipo === "vaquinha" && l.mesId === mesId)
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
          <p class="mercado-total__label">Total vaquinhas · ${escapeHtml(mesLabel)}</p>
          <p class="mercado-total__valor">${formatMoney(total)}</p>`;
      }
    }

    if (!items.length) {
      box.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    const acertosEncontro = atribuirAcertoVaquinhasDoEncontro(mesId);

    box.innerHTML = items
      .map((item) => {
        const meu = item.lancadoPorId && item.lancadoPorId === usuarioAtualId;
        const podeMexer = podeExcluirMes && (meu || isAdmin());
        const acerto = acertosEncontro[item.id];
        const quitada = !!acerto?.quitada;
        const statusBadge = quitada
          ? `<span class="badge badge--aberto">Quitada no encontro</span>`
          : acerto?.pago > 0.005
            ? `<span class="badge badge--fechado">Parcial no encontro</span>`
            : `<span class="badge badge--fechado">Em aberto</span>`;
        const acoes = [];
        const fotoBtn = htmlBtnComprovante(item, {
          kind: "lancamento",
          canAdd: !!(meu && podeExcluirMes && !srcComprovante(item)),
          canRemove: !!(meu && podeExcluirMes && srcComprovante(item)),
        });
        if (fotoBtn) acoes.push(fotoBtn);
        acoes.push(
          `<button type="button" class="btn btn--secondary btn--sm btn-ir-encontro" title="Acertar no Encontro">Encontro</button>`
        );
        if (podeMexer) {
          acoes.push(
            `<button type="button" class="btn btn--edit btn--sm btn-editar-vaquinha-lista" data-id="${item.id}" title="Editar">✎</button>`
          );
          acoes.push(
            `<button type="button" class="btn btn--ghost btn--sm btn-excluir-vaquinha-lista" data-id="${item.id}">Excluir</button>`
          );
        }
        const parts = (item.participantes || [])
          .map((p) => `${escapeHtml(p.nome)}: ${textoSaldo(p.saldo ?? 0).texto}`)
          .join(" · ");
        const comprasHtml = (item.compras || [])
          .map((c) => {
            const src = srcComprovanteCompra(c);
            const fotoLinha = src
              ? `<button type="button" class="btn btn--ghost btn--sm btn-ver-compra-foto" data-vaq-id="${escapeHtml(
                  item.id
                )}" data-compra-id="${escapeHtml(c.id)}" title="Ver notinha">📄</button>`
              : "";
            return `<div class="vaquinha-compra-linha">${escapeHtml(c.nome || "—")} · ${formatMoney(
              c.valor
            )} ${fotoLinha}</div>`;
          })
          .join("");
        return `
      <article class="mercado-item ${quitada ? "mercado-item--pago" : ""}">
        <div>
          <p class="mercado-item__meta">${formatDate(item.data)} · ${statusBadge}</p>
          <p class="mercado-item__detalhe">${escapeHtml(item.descricao || "—")}</p>
          <div class="vaquinha-compras-resumo">${
            comprasHtml || `<p class="mercado-item__por" style="margin-top:0.2rem">—</p>`
          }</div>
          <p class="mercado-item__por" style="margin-top:0.35rem">${parts || "—"}</p>
          ${htmlAcertoVaquinhaEncontro(acerto)}
        </div>
        <p class="mercado-item__valor">${formatMoney(item.valor)}</p>
        <div class="mercado-item__rodape">
          <p class="mercado-item__por">Por ${escapeHtml(item.lancadoPorNome || "—")}</p>
          <div class="mercado-item__acoes">${acoes.join("")}</div>
        </div>
      </article>`;
      })
      .join("");

    wireComprovanteListEvents(box);

    box.querySelectorAll(".btn-ver-compra-foto").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = state.lancamentos.find(
          (l) => l.id === btn.dataset.vaqId && l.tipo === "vaquinha"
        );
        const compra = (item?.compras || []).find((c) => c.id === btn.dataset.compraId);
        const src = srcComprovanteCompra(compra);
        if (src) abrirComprovante(src, { canRemove: false });
      });
    });

    box.querySelectorAll(".btn-ir-encontro").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".nav__btn").find((b) => b.dataset.tab === "encontro")?.click();
      });
    });

    box.querySelectorAll(".btn-editar-vaquinha-lista").forEach((btn) => {
      btn.addEventListener("click", () => iniciarEdicaoVaquinha(btn.dataset.id));
    });

    box.querySelectorAll(".btn-excluir-vaquinha-lista").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = state.lancamentos.find((l) => l.id === btn.dataset.id && l.tipo === "vaquinha");
        if (!item) return;
        if (!mesEstaAberto(item.mesId)) return toast("Só é possível excluir no mês aberto.");
        if (item.lancadoPorId !== usuarioAtualId && !isAdmin()) {
          return toast("Só quem lançou (ou o admin) pode excluir.");
        }
        if (!confirm(`Excluir vaquinha "${item.descricao}" (${formatMoney(item.valor)})?`)) return;

        if (item.comprovantePath) excluirComprovanteStorage(item.comprovantePath);
        if (item.comprovantePagamentoPath) excluirComprovanteStorage(item.comprovantePagamentoPath);
        (item.compras || []).forEach((c) => {
          if (c?.comprovantePath) excluirComprovanteStorage(c.comprovantePath);
        });
        if (editingVaquinhaId === item.id) limparEdicaoVaquinha();
        const autor = autorMeta();
        state.lancamentos = state.lancamentos.filter((l) => l.id !== item.id);
        notificarTodosExceto(autor.lancadoPorId, {
          titulo: "Vaquinha excluída",
          texto: `${autor.lancadoPorNome} excluiu a vaquinha "${item.descricao}" (${formatMoney(item.valor)}).`,
          tipo: "exclusao",
          refId: item.id,
        });
        saveState();
        clearTimeout(pushTimer);
        pushToCloud();
        updateNotifBadge();
        renderVaquinhaLista();
        renderRelatorio();
        renderEncontro();
        toast("Vaquinha excluída.");
      });
    });
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
    atualizarPushStatus();
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
    pendenciasVisiveis(state.pendencias)
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

    $("#btn-copiar-encontro")?.addEventListener("click", async () => {
      const texto = textoEncontroParaCopiar();
      if (!texto) return toast("Nada para copiar.");
      const ok = await copiarTexto(texto);
      toast(ok ? "Texto copiado para WhatsApp." : "Não foi possível copiar.");
    });

    $("#btn-imprimir-encontro")?.addEventListener("click", () => {
      imprimirEncontro();
    });

    $("#btn-copiar-relatorio")?.addEventListener("click", async () => {
      const texto = textoRelatorioParaCopiar();
      if (!texto) return toast("Nada para copiar.");
      const ok = await copiarTexto(texto);
      toast(ok ? "Texto copiado para WhatsApp." : "Não foi possível copiar.");
    });

    $("#btn-imprimir-relatorio")?.addEventListener("click", () => {
      imprimirRelatorio();
    });
  }

  function limparHtmlParaImpressao(html) {
    const wrap = document.createElement("div");
    wrap.innerHTML = html || "";
    wrap
      .querySelectorAll(
        "button, .btn, .export-acoes, .no-print, .relatorio-switch, .acerto-item__acoes, .mercado-item__acoes, form, input, select, textarea"
      )
      .forEach((el) => el.remove());
    return wrap.innerHTML;
  }

  function montarDocumentoImpressao(titulo, corpoHtml) {
    const estilo = `
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 16px;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        color: #111;
        background: #fff;
        font-size: 14px;
        line-height: 1.4;
      }
      h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
      .meta { color: #666; margin: 0 0 1rem; font-size: 0.85rem; }
      .card-resumo, .card-grupo, .acerto-item, .mercado-item {
        border: 1px solid #ddd;
        border-radius: 10px;
        padding: 0.75rem 0.9rem;
        margin: 0 0 0.55rem;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .grupos-grid, .resumo, .acerto-lista, .lista-mercado {
        display: block;
      }
      .card-grupo__nome, .card-resumo__label, .acerto-lista__titulo {
        margin: 0;
        font-size: 0.78rem;
        color: #666;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .card-grupo__valor, .card-resumo__valor, .acerto-item__valor, .mercado-item__valor {
        margin: 0.2rem 0 0;
        font-size: 1.15rem;
        font-weight: 700;
      }
      .card-grupo__peso, .card-grupo__origens, .card-resumo__meta,
      .mercado-item__meta, .mercado-item__por, .mercado-item__detalhe, .detalhe {
        margin: 0.2rem 0 0;
        color: #555;
        font-size: 0.82rem;
      }
      .saldo--receber { color: #1a5c4a; }
      .saldo--pagar { color: #b42318; }
      .saldo--ok { color: #666; }
      .acerto-item__fluxo { margin: 0; }
      .acerto-item__seta { margin: 0 0.35rem; color: #888; }
      .badge {
        display: inline-block;
        padding: 0.1rem 0.4rem;
        border-radius: 999px;
        background: #eee;
        font-size: 0.72rem;
      }
      table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; }
      th, td { border-bottom: 1px solid #e5e5e5; padding: 0.45rem 0.3rem; text-align: left; font-size: 0.85rem; }
      @page { margin: 12mm; }
      @media print {
        body { padding: 0; }
      }
    `;
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(titulo)}</title>
  <style>${estilo}</style>
</head>
<body>
  <h1>${escapeHtml(titulo)}</h1>
  <p class="meta">Gerado em ${new Date().toLocaleString("pt-BR")}</p>
  ${corpoHtml}
</body>
</html>`;
  }

  function podeUsarShareNativo() {
    return typeof navigator.share === "function";
  }

  function isIosStandalonePwa() {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent || "");
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    return ios && standalone;
  }

  async function compartilharTextoImpressao(titulo, texto) {
    if (!texto) return false;
    try {
      if (podeUsarShareNativo()) {
        await navigator.share({ title: titulo, text: texto });
        return true;
      }
    } catch (err) {
      if (String(err?.name || "") === "AbortError") return true;
    }
    return copiarTexto(texto);
  }

  function imprimirDocumento(titulo, corpoHtml) {
    const limpo = limparHtmlParaImpressao(corpoHtml);
    if (!String(limpo || "").trim()) {
      toast("Nada para imprimir.");
      return;
    }

    // No PWA do iPhone, window.print costuma não existir/funcionar — usa compartilhar
    if (isIosStandalonePwa()) {
      const textoPlano = `${titulo}\n\n${(limpo || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim()}`;
      compartilharTextoImpressao(titulo, textoPlano).then((ok) => {
        toast(
          ok
            ? "Use Compartilhar/Imprimir do iPhone."
            : "Neste iPhone instalado, use Copiar para WhatsApp."
        );
      });
      return;
    }

    const html = montarDocumentoImpressao(titulo, limpo);

    // iframe fora da tela (não pode ser 0x0 — quebra no iOS Safari)
    try {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.cssText =
        "position:fixed;top:-10000px;left:0;width:1024px;height:1400px;border:0;opacity:0;pointer-events:none;";
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) {
        doc.open();
        doc.write(html);
        doc.close();
        const win = iframe.contentWindow;
        const limparIframe = () => {
          try {
            iframe.remove();
          } catch {
            /* ignore */
          }
        };
        win?.addEventListener?.("afterprint", limparIframe);
        setTimeout(() => {
          try {
            win?.focus?.();
            win?.print?.();
            toast("Abrindo impressão…");
          } catch (err) {
            console.warn("print iframe:", err);
            limparIframe();
            abrirImpressaoEmNovaAba(html);
          }
          setTimeout(limparIframe, 5000);
        }, 250);
        return;
      }
    } catch (err) {
      console.warn("iframe print:", err);
    }

    abrirImpressaoEmNovaAba(html);
  }

  function abrirImpressaoEmNovaAba(html) {
    try {
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank");
      if (!win) {
        URL.revokeObjectURL(url);
        toast("Permita pop-ups para imprimir, ou use Copiar para WhatsApp.");
        return;
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast("Documento aberto — toque em Imprimir no navegador.");
    } catch (err) {
      console.warn("blob print:", err);
      toast("Não foi possível imprimir neste aparelho. Use Copiar para WhatsApp.");
    }
  }

  function imprimirEncontro() {
    const box = $("#encontro-resultado");
    if (!box || !box.innerHTML.trim()) return toast("Nada para imprimir.");
    const mesId = $("#encontro-mes")?.value || mesSelecionado;
    const titulo = `Encontro de contas — ${mesId ? labelMes(mesId) : "mês"}`;
    imprimirDocumento(titulo, box.innerHTML);
  }

  function imprimirRelatorio() {
    let bloco = null;
    if (relatorioModo === "vaquinha") bloco = $("#relatorio-vaquinha");
    else if (relatorioModo === "pendencias") bloco = $("#relatorio-pendencias");
    else bloco = $("#relatorio-casa");

    if (!bloco || bloco.classList.contains("hidden") || !bloco.innerHTML.trim()) {
      return toast("Nada para imprimir.");
    }
    const modo =
      relatorioModo === "vaquinha"
        ? "Vaquinha"
        : relatorioModo === "pendencias"
          ? "Entre nós"
          : "Mercado + Despesas";
    const titulo = `Relatório — ${modo} — ${mesSelecionado ? labelMes(mesSelecionado) : "mês"}`;
    imprimirDocumento(titulo, bloco.innerHTML);
  }

  function imprimirAba(classePrint) {
    // Compatibilidade com chamadas antigas
    if (classePrint === "print-encontro") return imprimirEncontro();
    if (classePrint === "print-relatorio") return imprimirRelatorio();
  }

  function textoLinhasTransferencias(transfers, mesId, escopo) {
    const ativas = (transfers || []).filter((t) => Number(t.valor) > 0.005);
    if (!ativas.length) return ["(nenhuma transferência)"];
    return ativas.map((t) => {
      const quit = mesId && escopo && quitacaoExiste(mesId, escopo, t) ? " ✅" : "";
      return `• ${t.deNome} → ${t.paraNome}: ${formatMoney(t.valor)}${quit}`;
    });
  }

  function textoEncontroParaCopiar() {
    const mesId = $("#encontro-mes")?.value || mesSelecionado;
    if (!mesId) return "";
    const useCasa = $("#enc-casa")?.checked;
    const useVaq = $("#enc-vaquinha")?.checked;
    const usePend = $("#enc-pendencias")?.checked;
    if (!useCasa && !useVaq && !usePend) return "";

    const origens = [
      useCasa ? "Mercado+Despesas" : null,
      useVaq ? "Vaquinha" : null,
      usePend ? "Entre nós" : null,
    ].filter(Boolean);

    const saldos = calcularSaldosEncontro(mesId, {
      casa: useCasa,
      vaquinha: useVaq,
      pendencias: usePend,
    });
    const transfers = calcularTransferencias(saldos);

    const linhas = [
      `*Encontro — ${labelMes(mesId)}*`,
      origens.join(" · "),
      "",
      "*Saldo líquido (tudo somado)*",
    ];
    saldos.forEach((s) => {
      const t = textoSaldo(s.saldo);
      linhas.push(`• ${s.nome}: ${t.texto}`);
      const det = Array.isArray(s.detalheOrigens) ? s.detalheOrigens : [];
      if (det.length) {
        const partes = det.map((d) => {
          const v = Math.abs(Number(d.saldo) || 0);
          const net = Number(s.saldo) || 0;
          const mesmoLado =
            Math.abs(net) < 0.005 || (net > 0 && d.saldo > 0) || (net < 0 && d.saldo < 0);
          if (mesmoLado) return `${formatMoney(v)} de ${d.label}`;
          const lado = d.saldo > 0 ? "a receber" : "a pagar";
          return `${formatMoney(v)} ${lado} (${d.label})`;
        });
        linhas.push(`  ${partes.join(" · ")}`);
      }
    });
    linhas.push("", "*Quem passa pra quem*", ...textoLinhasTransferencias(transfers, mesId, "encontro"));
    return linhas.join("\n").trim();
  }

  function textoRelatorioParaCopiar() {
    const mesId = mesSelecionado;
    if (!mesId) return "";
    const titulo = labelMes(mesId);

    if (relatorioModo === "vaquinha") {
      const vaquinhas = state.lancamentos.filter(
        (l) => l.tipo === "vaquinha" && l.mesId === mesId
      );
      const saldos = calcularSaldosPessoasVaquinha(mesId);
      const transfers = calcularTransferencias(saldos);
      const total = vaquinhas.reduce((acc, v) => acc + (Number(v.valor) || 0), 0);
      const linhas = [
        `*Vaquinhas — ${titulo}*`,
        `Total: ${formatMoney(total)} · ${vaquinhas.length} vaquinha(s)`,
        "",
        "*Acerto*",
        ...textoLinhasTransferencias(transfers),
        "",
      ];
      vaquinhas.forEach((v) => {
        linhas.push(`• ${formatDate(v.data)} — ${v.descricao}: ${formatMoney(v.valor)}`);
      });
      return linhas.join("\n").trim();
    }

    if (relatorioModo === "pendencias") {
      const items = pendenciasVisiveis(state.pendencias).filter(
        (p) => (p.data || "").slice(0, 7) === mesId
      );
      const abertas = items.filter((p) => p.status === "pendente");
      const saldos = calcularSaldosPendenciasMes(mesId);
      const transfers = calcularTransferencias(saldos);
      const total = abertas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
      const linhas = [
        `*Entre nós — ${titulo}*`,
        `Abertas: ${formatMoney(total)} · ${abertas.length} de ${items.length}`,
        "",
        "*Acerto*",
        ...textoLinhasTransferencias(transfers),
        "",
      ];
      items.forEach((p) => {
        const st = p.status === "pago" ? "pago" : "pendente";
        linhas.push(
          `• ${formatDate(p.data)} — ${p.descricao}: ${formatMoney(p.valor)} (${p.devedorNome} → ${p.credorNome}, ${st})`
        );
      });
      return linhas.join("\n").trim();
    }

    const items = state.lancamentos.filter(
      (l) => l.mesId === mesId && (l.tipo === "mercado" || l.tipo === "despesa")
    );
    const total = items.reduce((acc, i) => acc + (Number(i.valor) || 0), 0);
    const saldos = calcularSaldosGrupos(items);
    const transfers = calcularTransferencias(saldos);
    const linhas = [
      `*Mercado + Despesas — ${titulo}*`,
      `Total: ${formatMoney(total)} · ${items.length} lançamento(s)`,
      "",
      "*Acerto*",
      ...textoLinhasTransferencias(transfers),
      "",
    ];
    items
      .slice()
      .sort((a, b) => (b.data || "").localeCompare(a.data || ""))
      .forEach((item) => {
        const tipo = item.tipo === "mercado" ? "Mercado" : item.descricao || "Despesa";
        linhas.push(`• ${formatDate(item.data)} — ${tipo}: ${formatMoney(item.valor)}`);
      });
    return linhas.join("\n").trim();
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

    const origens = [
      useCasa ? "Mercado+Despesas" : null,
      useVaq ? "Vaquinha" : null,
      usePend ? "Entre nós" : null,
    ].filter(Boolean);

    const saldos = calcularSaldosEncontro(mesId, {
      casa: useCasa,
      vaquinha: useVaq,
      pendencias: usePend,
    });
    const transfers = calcularTransferencias(saldos);

    box.innerHTML = htmlBlocoAcerto({
      titulo: `Encontro — ${labelMes(mesId)}`,
      meta: `${origens.join(" · ")} · saldo líquido (compensado entre as origens)`,
      saldos,
      transfers,
      vazio: !saldos.length,
      mesId,
      escopo: "encontro",
    });
    bindQuitacaoButtons(box);
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
          ? `<div class="acerto-item__acoes no-print">
              <button type="button" class="btn btn--edit btn--sm btn-editar-rel" data-id="${item.id}" data-tipo="${item.tipo}" title="Editar">✎</button>
              <button type="button" class="btn btn--icon btn-excluir" data-id="${item.id}" title="Excluir">×</button>
            </div>`
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

    tbody.querySelectorAll(".btn-editar-rel").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tipo = btn.dataset.tipo;
        if (tipo === "mercado") {
          $$(".nav__btn").find((b) => b.dataset.tab === "mercado")?.click();
          iniciarEdicaoMercado(btn.dataset.id);
        } else if (tipo === "despesa") {
          $$(".nav__btn").find((b) => b.dataset.tab === "despesas")?.click();
          iniciarEdicaoDespesa(btn.dataset.id);
        } else if (tipo === "vaquinha") {
          $$(".nav__btn").find((b) => b.dataset.tab === "vaquinha")?.click();
          iniciarEdicaoVaquinha(btn.dataset.id);
        }
      });
    });

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
        renderVaquinhaLista();
        renderEncontro();
        toast("Excluído.");
      });
    });
  }

  function renderRelatorioVaquinha() {
    const vaquinhas = state.lancamentos
      .filter((l) => l.tipo === "vaquinha" && l.mesId === mesSelecionado)
      .sort((a, b) => b.data.localeCompare(a.data));
    const acertosEncontro = atribuirAcertoVaquinhasDoEncontro(mesSelecionado);
    const emAberto = vaquinhas.filter((v) => (acertosEncontro[v.id]?.falta || 0) > 0.005).length;
    const saldos = calcularSaldosPessoasVaquinha(mesSelecionado);
    const transfers = calcularTransferencias(saldos);
    const total = vaquinhas.reduce((acc, v) => acc + (Number(v.valor) || 0), 0);
    const tituloMes = mesSelecionado ? labelMes(mesSelecionado) : "Nenhum mês";

    $("#resumo-vaquinhas").innerHTML =
      `
      <div class="card-resumo">
        <p class="card-resumo__label">Vaquinhas — ${escapeHtml(tituloMes)}</p>
        <p class="card-resumo__valor" style="color:var(--brand)">${formatMoney(total)}</p>
        <p class="card-resumo__meta">${vaquinhas.length} vaquinha(s) · ${emAberto} com acerto em aberto</p>
      </div>` +
      htmlBlocoAcerto({
        titulo: "Acerto das vaquinhas",
        meta: "Quem passa pra quem nas vaquinhas deste mês (quite no Encontro).",
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
    const podeEditarMes = mesEstaAberto(mesSelecionado);
    lista.innerHTML = vaquinhas
      .map((v) => {
        const parts = (v.participantes || [])
          .map((p) => `${escapeHtml(p.nome)}: ${textoSaldo(p.saldo ?? 0).texto}`)
          .join(" · ");
        const meu = v.lancadoPorId === usuarioAtualId;
        const podeMexer = podeEditarMes && (meu || isAdmin());
        const acerto = acertosEncontro[v.id];
        const quitada = !!acerto?.quitada;
        const statusBadge = quitada
          ? `<span class="badge badge--aberto">Quitada no encontro</span>`
          : acerto?.pago > 0.005
            ? `<span class="badge badge--fechado">Parcial no encontro</span>`
            : `<span class="badge badge--fechado">Em aberto</span>`;
        const acoes = [];
        acoes.push(
          `<button type="button" class="btn btn--secondary btn--sm btn-ir-encontro">Encontro</button>`
        );
        if (podeMexer) {
          acoes.push(
            `<button type="button" class="btn btn--edit btn--sm btn-editar-vaquinha" data-id="${v.id}" title="Editar">✎</button>`
          );
          acoes.push(
            `<button type="button" class="btn btn--ghost btn--sm btn-excluir-vaquinha" data-id="${v.id}">Excluir</button>`
          );
        }
        return `
      <article class="mercado-item ${quitada ? "mercado-item--pago" : ""}">
        <div>
          <p class="mercado-item__meta">${formatDate(v.data)} · ${statusBadge}</p>
          <p class="mercado-item__detalhe">${escapeHtml(v.descricao)}</p>
          <div class="vaquinha-compras-resumo">${(v.compras || [])
            .map((c) => {
              const src = srcComprovanteCompra(c);
              const fotoBtn = src
                ? `<button type="button" class="btn btn--ghost btn--sm btn-ver-compra-foto" data-vaq-id="${escapeHtml(
                    v.id
                  )}" data-compra-id="${escapeHtml(c.id)}" title="Ver notinha">📄</button>`
                : "";
              return `<div class="vaquinha-compra-linha">${escapeHtml(c.nome || "—")} · ${formatMoney(
                c.valor
              )} ${fotoBtn}</div>`;
            })
            .join("")}</div>
          <p class="mercado-item__por" style="margin-top:0.25rem">${parts || "—"}</p>
          ${htmlAcertoVaquinhaEncontro(acerto)}
        </div>
        <p class="mercado-item__valor">${formatMoney(v.valor)}</p>
        <div class="mercado-item__rodape">
          <p class="mercado-item__por">Por ${escapeHtml(v.lancadoPorNome || "—")}</p>
          <div class="mercado-item__acoes">${acoes.join("")}</div>
        </div>
      </article>`;
      })
      .join("");

    lista.querySelectorAll(".btn-ver-compra-foto").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = state.lancamentos.find(
          (l) => l.id === btn.dataset.vaqId && l.tipo === "vaquinha"
        );
        const compra = (item?.compras || []).find((c) => c.id === btn.dataset.compraId);
        const src = srcComprovanteCompra(compra);
        if (src) abrirComprovante(src, { canRemove: false });
      });
    });

    lista.querySelectorAll(".btn-ir-encontro").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".nav__btn").find((b) => b.dataset.tab === "encontro")?.click();
      });
    });

    lista.querySelectorAll(".btn-editar-vaquinha").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".nav__btn").find((b) => b.dataset.tab === "vaquinha")?.click();
        iniciarEdicaoVaquinha(btn.dataset.id);
      });
    });

    lista.querySelectorAll(".btn-excluir-vaquinha").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = state.lancamentos.find((l) => l.id === btn.dataset.id && l.tipo === "vaquinha");
        if (!item) return;
        if (!mesEstaAberto(item.mesId)) return toast("Só é possível excluir no mês aberto.");
        if (item.lancadoPorId !== usuarioAtualId && !isAdmin()) {
          return toast("Só quem lançou (ou o admin) pode excluir.");
        }
        if (!confirm(`Excluir vaquinha "${item.descricao}" (${formatMoney(item.valor)})?`)) return;
        if (item.comprovantePath) excluirComprovanteStorage(item.comprovantePath);
        if (item.comprovantePagamentoPath) excluirComprovanteStorage(item.comprovantePagamentoPath);
        (item.compras || []).forEach((c) => {
          if (c?.comprovantePath) excluirComprovanteStorage(c.comprovantePath);
        });
        if (editingVaquinhaId === item.id) limparEdicaoVaquinha();
        const autor = autorMeta();
        state.lancamentos = state.lancamentos.filter((l) => l.id !== item.id);
        notificarTodosExceto(autor.lancadoPorId, {
          titulo: "Vaquinha excluída",
          texto: `${autor.lancadoPorNome} excluiu a vaquinha "${item.descricao}" (${formatMoney(item.valor)}).`,
          tipo: "exclusao",
          refId: item.id,
        });
        saveState();
        clearTimeout(pushTimer);
        pushToCloud();
        updateNotifBadge();
        renderVaquinhaLista();
        renderRelatorio();
        renderEncontro();
        toast("Vaquinha excluída.");
      });
    });
  }

  function renderRelatorioPendencias() {
    const mesId = mesSelecionado;
    const items = pendenciasVisiveis(state.pendencias)
      .filter((p) => (p.data || "").slice(0, 7) === mesId)
      .sort((a, b) => (b.data || "").localeCompare(a.data || ""));
    const abertas = items.filter((p) => p.status === "pendente");
    const saldos = calcularSaldosPendenciasMes(mesId);
    const transfers = calcularTransferencias(saldos);
    const total = abertas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    const tituloMes = mesId ? labelMes(mesId) : "Nenhum mês";
    const metaAcerto = isAdmin()
      ? "Pendências abertas com data neste mês (visão admin)."
      : "Só suas pendências abertas neste mês.";

    $("#resumo-rel-pendencias").innerHTML =
      `
      <div class="card-resumo">
        <p class="card-resumo__label">Entre nós — ${escapeHtml(tituloMes)}</p>
        <p class="card-resumo__valor">${formatMoney(total)}</p>
        <p class="card-resumo__meta">${abertas.length} aberta(s) · ${items.length} no mês</p>
      </div>` +
      htmlBlocoAcerto({
        titulo: "Acerto entre nós",
        meta: metaAcerto,
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
      empty.textContent = isAdmin()
        ? "Nenhuma pendência com data neste mês."
        : "Nenhuma pendência sua com data neste mês.";
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
          .register(`./sw.js?v=${APP_BUILD}`, { scope: "./" })
          .then((reg) => {
            reg.update();
            setInterval(() => reg.update(), 30 * 60 * 1000);
            reg.addEventListener("updatefound", () => {
              const worker = reg.installing;
              if (!worker) return;
              worker.addEventListener("statechange", () => {
                if (worker.state === "installed" && navigator.serviceWorker.controller) {
                  toast("Nova versão disponível — atualizando…");
                  worker.postMessage("SKIP_WAITING");
                }
              });
            });
          })
          .catch((err) => console.warn("SW:", err));

        // Força limpeza de caches antigos travados (ex.: v50)
        caches.keys().then((keys) => {
          keys
            .filter((k) => k.startsWith("despesas-") && k !== `despesas-${APP_BUILD}`)
            .forEach((k) => caches.delete(k));
        });
      });

      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        if (sessionStorage.getItem("despesas-sw-reloaded") === "1") return;
        refreshing = true;
        sessionStorage.setItem("despesas-sw-reloaded", "1");
        location.reload();
      });

      // libera novo reload em aberturas futuras
      setTimeout(() => sessionStorage.removeItem("despesas-sw-reloaded"), 4000);
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
    $("#btn-ativar-push")?.addEventListener("click", () => {
      ativarNotificacoesPush();
    });
    $("#btn-banner-push-ativar")?.addEventListener("click", () => {
      ativarNotificacoesPush();
    });
    $("#btn-banner-push-depois")?.addEventListener("click", () => {
      dispensarPushPrompt(3);
      toast("Ok. Você pode ativar depois em Config.");
    });
    $("#btn-modal-push-ativar")?.addEventListener("click", async () => {
      const ok = await ativarNotificacoesPush();
      if (!ok && Notification.permission === "denied") {
        /* modal já mostra instruções */
      }
    });
    $("#btn-modal-push-config")?.addEventListener("click", () => {
      fecharModalAtivarPush();
      irParaConfig();
    });
    $("#btn-modal-push-depois")?.addEventListener("click", () => {
      fecharModalAtivarPush();
      dispensarPushPrompt(3);
    });
    $("#modal-ativar-push")?.addEventListener("cancel", (e) => {
      e.preventDefault();
      fecharModalAtivarPush();
      dispensarPushPrompt(1);
    });
    atualizarPushStatus();
    updateInstallHint();
  }

  function init() {
    // Normaliza em memória; só grava depois do sync (evita timestamp novo em cima de cópia pobre)
    normalizarPendenciasIds();
    document.querySelectorAll("dialog[open]").forEach((d) => {
      try {
        d.close();
      } catch (_) {
        /* ignore */
      }
    });
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

    $("#btn-restaurar-backup")?.addEventListener("click", () => {
      const backup = lerBackupLocal();
      if (!backup?.state) return toast("Nenhum backup local encontrado neste aparelho.");
      const scoreB = scoreEstado(backup.state);
      const scoreA = scoreEstado(state);
      if (
        !confirm(
          `Restaurar backup de ${backup.salvoEm || "data desconhecida"}?\n` +
            `Backup: score ${scoreB} · Atual: score ${scoreA}`
        )
      ) {
        return;
      }
      applyingRemote = true;
      try {
        state = { ...backup.state, updatedAt: Date.now() };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } finally {
        applyingRemote = false;
      }
      saveState();
      updateMesStatus();
      fillFiltroMes();
      renderRelatorio();
      renderMercadoLista();
      renderDespesaLista();
      renderPendencias();
      renderPessoal();
      fillConfigForm();
      toast("Backup local restaurado. Sincronizando…");
      pushToCloud();
    });

    const salvoId = lerSessaoUsuarioId();
    const boot = async () => {
      salvarBackupLocal("boot");
      if (codigoCasa) await startSync(codigoCasa);
      if (salvoId) {
        const atualizado = state.pessoas.find((p) => p.id === salvoId);
        if (atualizado && pessoaPrecisaDefinirSenha(atualizado)) {
          forcarTelaLoginParaDefinirSenha(atualizado);
        } else if (atualizado) {
          entrarComo(atualizado);
        } else {
          usuarioAtualId = null;
          limparSessaoPersistida();
          $("#tela-login").classList.remove("hidden");
          $("#app").classList.add("hidden");
        }
      } else {
        usuarioAtualId = null;
        $("#tela-login").classList.remove("hidden");
        $("#app").classList.add("hidden");
      }
    };
    boot();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
