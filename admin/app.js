// ============================================
// Painel Admin · abem:
// Login com Supabase Auth + gestão completa
// ============================================

const SUPABASE_URL = 'https://hhozgecuyczrbvyzvaoz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhob3pnZWN1eWN6cmJ2eXp2YW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY4MjA1NjUsImV4cCI6MjA2MjM5NjU2NX0.26C81920FzVHVCp6OFqCUhoo6NfDnVnTZhskVNuR5qo';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helper rápido
function $(id) { return document.getElementById(id); }
function $$(sel) { return document.querySelectorAll(sel); }
function escapeHTML(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function showView(name) {
  $$('.admin-view').forEach(v => {
    v.hidden = (v.dataset.view !== name);
  });
}

function showSection(name) {
  $$('.admin-section').forEach(s => { s.hidden = !s.id.endsWith(name); });
  $$('.admin-nav__btn').forEach(b => {
    b.classList.toggle('admin-nav__btn--active', b.dataset.section === name);
  });
}

// ============================================
// SESSÃO + LOGIN
// ============================================

let _adminProfile = null; // { user_id, nome, cargo }

async function checkSession(sessaoConhecida = null) {
  let session = sessaoConhecida;
  if (!session) {
    const { data } = await sb.auth.getSession();
    session = data.session;
  }
  if (!session) {
    showView('login');
    return false;
  }
  // Verificar se este user_id é admin
  const { data: admin, error } = await sb.from('admins')
    .select('user_id, nome, cargo')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (error || !admin) {
    // Não é admin — força logout
    await sb.auth.signOut();
    showLoginError('Esta conta não tem permissões de administrador.');
    showView('login');
    return false;
  }

  _adminProfile = admin;
  $('admin-nome').textContent = admin.nome;
  showView('app');
  await loadDashboard();
  return true;
}

function showLoginError(msg) {
  const el = $('login-error');
  el.textContent = msg;
  el.hidden = false;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;

  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) {
    showLoginError('Indique email e password.');
    return;
  }

  const btn = e.submitter || e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'A entrar…';

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  btn.textContent = original;

  if (error) {
    // Mostrar mensagem específica do Supabase para diagnóstico
    console.error('Login error:', error);
    let msg = error.message || 'Erro desconhecido';
    if (msg.toLowerCase().includes('email not confirmed')) {
     msg = 'Email não está confirmado no Supabase. Vai a Authentication → Users e ativa "Auto Confirm" para este utilizador.';
    } else if (msg.toLowerCase().includes('invalid login credentials')) {
      msg = 'Email ou password errados. Verifica os dois (cuidado com espaços e maiúsculas).';
    }
    showLoginError(msg);
    return;
  }
 await checkSession(data.session);
});

$('admin-logout').addEventListener('click', async () => {
  if (!confirm('Terminar sessão?')) return;
  await sb.auth.signOut();
  _adminProfile = null;
  $('login-form').reset();
  showView('login');
});

// ============================================
// NAVEGAÇÃO ENTRE SECÇÕES
// ============================================

$$('.admin-nav__btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const sec = btn.dataset.section;
    showSection(sec);
    if (sec === 'dashboard') await loadDashboard();
    else if (sec === 'utilizadores') await loadUtilizadores();
    else if (sec === 'pontuacoes') await loadPontuacoes();
    else if (sec === 'recompensas') await loadRecompensas();
  });
});

// ============================================
// DASHBOARD
// ============================================
// Mapa PIN -> estado/pseudonimo, para os ecras que leem de resultados/recompensas
// (essas tabelas guardam sempre o PIN real; o pseudonimo vive em Utilizadores)
let _estadoPorPin = {};

async function carregarEstadosBeneficiarios() {
  const { data } = await sb.from('Utilizadores')
    .select('numbeneficiario, estado, pseudonimo');
  _estadoPorPin = {};
  (data || []).forEach(u => { _estadoPorPin[u.numbeneficiario] = u; });
}

function etiquetaBeneficiario(pin) {
  const u = _estadoPorPin[pin];
  if (u && u.estado === 'consentimento_retirado') {
    return u.pseudonimo || '(sem pseudónimo)';
  }
  return pin;
}
async function loadDashboard() {
  await carregarEstadosBeneficiarios();
  // Stats globais em paralelo
  const [utilizadoresCount, resultadosAll, recompensasCount, top10, recRecentes] = await Promise.all([
    sb.from('Utilizadores').select('*', { count: 'exact', head: true }),
    sb.from('resultados').select('percentagem'),
    sb.from('recompensas').select('*', { count: 'exact', head: true }),
    sb.from('resultados')
      .select('numero_beneficiario, nivel_nome, percentagem, acertos, total_perguntas, criado_em')
      .order('percentagem', { ascending: false })
      .order('criado_em', { ascending: false })
      .limit(10),
    sb.from('recompensas')
      .select('id, numero_beneficiario, tipo, titulo, criado_em')
      .order('criado_em', { ascending: false })
      .limit(5),
  ]);

  $('stat-utilizadores').textContent = utilizadoresCount.count ?? '—';
  const totalResultados = resultadosAll.data?.length || 0;
  $('stat-quizzes').textContent = totalResultados;
  $('stat-recompensas').textContent = recompensasCount.count ?? '—';

  if (totalResultados > 0) {
    const media = Math.round(
      resultadosAll.data.reduce((s, r) => s + (r.percentagem || 0), 0) / totalResultados
    );
    $('stat-media').textContent = `${media}%`;
  } else {
    $('stat-media').textContent = '—';
  }

  renderTop10(top10.data || []);
  renderRecompensasRecentes(recRecentes.data || []);
}

function renderTop10(rows) {
  const wrap = $('top10');
  if (rows.length === 0) {
    wrap.innerHTML = '<div class="empty">Ainda sem resultados de quizzes.</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>#</th><th>Beneficiário</th><th>Nível</th><th class="num">Pontuação</th><th>Data</th></tr>
      </thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr class="clickable" data-numero="${escapeHTML(r.numero_beneficiario)}">
            <td class="num">${i + 1}</td>
            <td>${escapeHTML(etiquetaBeneficiario(r.numero_beneficiario))}</td>
            <td>${escapeHTML(r.nivel_nome || '—')}</td>
            <td class="num">${r.percentagem}% <small>(${r.acertos}/${r.total_perguntas})</small></td>
            <td>${formatDateShort(r.criado_em)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => goToDetalheUtilizador(tr.dataset.numero));
  });
}

function renderRecompensasRecentes(rows) {
  const wrap = $('recompensas-recentes');
  if (rows.length === 0) {
    wrap.innerHTML = '<div class="empty">Ainda nenhuma recompensa atribuída.</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>Beneficiário</th><th>Tipo</th><th>Título</th><th>Data</th></tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr class="clickable" data-numero="${escapeHTML(r.numero_beneficiario)}">
           <td>${escapeHTML(etiquetaBeneficiario(r.numero_beneficiario))}</td>
            <td><span class="badge badge--${r.tipo}">${r.tipo === 'voucher' ? '🎟️ Voucher' : (r.imagem_url ? '🖼️ Imagem' : '🏅 Medalha')}</span></td>
            <td>${escapeHTML(r.titulo)}</td>
            <td>${formatDateShort(r.criado_em)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => goToDetalheUtilizador(tr.dataset.numero));
  });
}

// ============================================
// UTILIZADORES
// ============================================

let _utilizadoresAll = [];

async function loadUtilizadores() {
  const wrap = $('utilizadores-lista');
  wrap.innerHTML = '<div class="loading">A carregar…</div>';

  const { data, error } = await sb.from('Utilizadores')
    .select('numbeneficiario, anonascimento, estado, pseudonimo')
    .order('numbeneficiario');

  if (error) {
    wrap.innerHTML = `<div class="error">Erro: ${escapeHTML(error.message)}</div>`;
    return;
  }
  _utilizadoresAll = data || [];
  aplicarFiltrosUtilizadores();
}

function renderUtilizadores(rows) {
  const wrap = $('utilizadores-lista');
  if (rows.length === 0) {
    wrap.innerHTML = _utilizadoresAll.length > 0
      ? '<div class="empty">Sem resultados para esta pesquisa ou filtro.</div>'
      : '<div class="empty">Sem utilizadores. Toque em "+ Novo utilizador" para adicionar.</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Beneficiário</th>
          <th>Ano nascimento</th>
          <th>Estado</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(u => {
          const retirado = (u.estado === 'consentimento_retirado');
          const etiqueta = retirado
            ? (u.pseudonimo || '(sem pseudónimo)')
            : u.numbeneficiario;
          const badge = retirado
            ? '<span class="badge badge--retirado">Consentimento retirado</span>'
            : '<span class="badge badge--ativo">Ativo</span>';
          return `
          <tr class="clickable" data-numero="${escapeHTML(u.numbeneficiario)}">
            <td><strong>${escapeHTML(etiqueta)}</strong></td>
            <td>${retirado ? '—' : u.anonascimento}</td>
            <td>${badge}</td>
            <td style="text-align:right">→</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => goToDetalheUtilizador(tr.dataset.numero));
  });
}

function aplicarFiltrosUtilizadores() {
  const q = ($('utilizadores-search').value || '').trim().toLowerCase();
  const estado = $('utilizadores-filtro-estado').value;

  const filtrados = _utilizadoresAll.filter(u => {
    if (estado && (u.estado || 'ativo') !== estado) return false;
    if (!q) return true;
    return String(u.numbeneficiario).toLowerCase().includes(q)
        || String(u.pseudonimo || '').toLowerCase().includes(q);
  });

  renderUtilizadores(filtrados);
}

$('utilizadores-search').addEventListener('input', aplicarFiltrosUtilizadores);
$('utilizadores-filtro-estado').addEventListener('change', aplicarFiltrosUtilizadores);
$('btn-limpar-teste').addEventListener('click', async () => {
  const ok = confirm('Apagar TODOS os dados de teste (numeros comecados por TESTE-)?\n\nOs dados reais nao sao afetados.');
  if (!ok) return;

  const b = $('btn-limpar-teste');
  const out = $('limpeza-teste-resultado');
  b.disabled = true; b.textContent = 'A limpar…';

  try {
    const { data, error } = await sb.rpc('limpar_beneficiarios_de_teste');
    if (error) throw error;
    const d = data || {};
    out.hidden = false;
    out.textContent = 'Apagados: ' + (d.utilizadores_apagados || 0) + ' beneficiarios, '
      + (d.respostas_apagadas || 0) + ' respostas, '
      + (d.resultados_apagados || 0) + ' resultados, '
      + (d.recompensas_apagadas || 0) + ' recompensas, '
      + (d.consentimentos_apagados || 0) + ' consentimentos.';
    announce('Dados de teste apagados.');
    await loadUtilizadores();
  } catch (err) {
    out.hidden = false;
    out.textContent = 'Erro: ' + (err.message || err);
  } finally {
    b.disabled = false; b.textContent = 'Limpar dados de teste';
  }
});
// ============================================
// DETALHE DO UTILIZADOR
// ============================================

let _detalheNumero = null;

async function goToDetalheUtilizador(numero) {
  _detalheNumero = numero;
  showSection('utilizador-detalhe');

  const wrap = $('detalhe-conteudo');
  wrap.innerHTML = '<div class="loading">A carregar…</div>';

  // Carregar tudo em paralelo
  const [user, resultados, recompensas] = await Promise.all([
    sb.from('Utilizadores')
      .select('numbeneficiario, anonascimento, estado, pseudonimo')
      .eq('numbeneficiario', numero)
      .maybeSingle(),
    sb.from('resultados')
      .select('*')
      .eq('numero_beneficiario', numero)
      .order('criado_em', { ascending: false }),
    sb.from('recompensas')
      .select('*')
      .eq('numero_beneficiario', numero)
      .order('criado_em', { ascending: false }),
  ]);

  if (!user.data) {
    wrap.innerHTML = '<div class="error">Utilizador não encontrado.</div>';
    return;
  }

  const u = user.data;
  const res = resultados.data || [];
  const rec = recompensas.data || [];
  const totalQuizzes = res.length;
  const media = totalQuizzes > 0
    ? Math.round(res.reduce((s, r) => s + (r.percentagem || 0), 0) / totalQuizzes)
    : 0;

  const retirado = (u.estado === 'consentimento_retirado');
  const etiqueta = retirado ? (u.pseudonimo || '(sem pseudónimo)') : u.numbeneficiario;

  wrap.innerHTML = `
    <div class="detalhe-header">
      <div>
        <div class="detalhe-numero">${escapeHTML(etiqueta)}</div>
        ${retirado
          ? '<div class="detalhe-info"><span class="badge badge--retirado">Consentimento retirado</span></div>'
          : `<div class="detalhe-info">Ano de nascimento: ${u.anonascimento}</div>`
        }
      </div>
      ${retirado
        ? ''
        : '<button id="atribuir-rec" class="btn btn--primary btn--small">+ Atribuir recompensa</button>'
      }
    </div>

    <div class="stats-grid stats-grid--admin">
      <div class="stat-card">
        <span class="stat-card__label">Quizzes feitos</span>
        <span class="stat-card__value">${totalQuizzes}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card__label">Pontuação média</span>
        <span class="stat-card__value">${totalQuizzes > 0 ? media + '%' : '—'}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card__label">Recompensas</span>
        <span class="stat-card__value">${rec.length}</span>
      </div>
    </div>

    <div class="admin-card">
      <h3>Recompensas atribuídas</h3>
      ${rec.length === 0
        ? '<div class="empty">Sem recompensas atribuídas.</div>'
        : rec.map(renderRecompensaCard).join('')
      }
    </div>

    <div class="admin-card">
      <h3>Histórico de quizzes</h3>
      ${res.length === 0
        ? '<div class="empty">Sem quizzes realizados.</div>'
        : `<table class="admin-table">
            <thead><tr><th>Nível</th><th class="num">Resultado</th><th>Data</th></tr></thead>
            <tbody>
              ${res.map(r => `
                <tr>
                  <td>${escapeHTML(r.nivel_nome || '—')}</td>
                  <td class="num">${r.percentagem}% <small>(${r.acertos}/${r.total_perguntas})</small></td>
                  <td>${formatDateShort(r.criado_em)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
      }
    </div>
  `;

  if (!retirado) {
    $('atribuir-rec').addEventListener('click', () => openModalRecompensa(numero));
  }

  // === Fase 5 — Consentimento retirado: reativar acesso ===
  if (retirado) {
    wrap.insertAdjacentHTML('beforeend', `
      <div class="admin-card" style="margin-top:1rem">
        <h3>Consentimento retirado</h3>
        <p class="hint">O acesso à app está suspenso e o número de beneficiário está oculto no painel. Os quizzes e as recompensas foram mantidos. Reativar devolve apenas o acesso — o consentimento volta a ser pedido à pessoa na próxima entrada na app.</p>
        <button id="btn-reativar" class="btn btn--primary btn--small">Reativar acesso</button>
      </div>
    `);

    $('btn-reativar').addEventListener('click', async () => {
      const ok = confirm('Reativar o acesso deste beneficiário?\n\nO consentimento será pedido de novo à pessoa na próxima entrada na app.');
      if (!ok) return;
      const b = $('btn-reativar');
      b.disabled = true; b.textContent = 'A reativar…';
      try {
        const { error } = await sb.rpc('reativar_beneficiario', { p_pin: numero });
        if (error) throw error;
        announce('Beneficiário reativado.');
        await loadUtilizadores();
        await goToDetalheUtilizador(numero);
      } catch (err) {
        alert('Erro: ' + (err.message || err));
        b.disabled = false; b.textContent = 'Reativar acesso';
      }
    });
  }
}

function renderRecompensaCard(r) {
  const dataStr = formatDateShort(r.criado_em);
  if (r.tipo === 'imagem' && r.imagem_url) {
    return `
      <div class="recompensa-card">
        <img src="${escapeHTML(r.imagem_url)}" alt="" class="recompensa-card__img">
        <div class="recompensa-card__body">
          <div class="recompensa-card__titulo">${escapeHTML(r.titulo)}</div>
          ${r.descricao ? `<div class="recompensa-card__meta">${escapeHTML(r.descricao)}</div>` : ''}
          <div class="recompensa-card__meta">Atribuída em ${dataStr}</div>
        </div>
      </div>
    `;
  }
  // voucher
  // sem imagem: voucher (🎟️) ou medalha (🏅, quando é do tipo imagem mas sem ficheiro)
  const semImagemIcon = (r.tipo === 'voucher') ? '🎟️' : '🏅';
  return `
    <div class="recompensa-card">
      <div class="recompensa-card__icon">${semImagemIcon}</div>
      <div class="recompensa-card__body">
        <div class="recompensa-card__titulo">${escapeHTML(r.titulo)}</div>
        ${r.descricao ? `<div class="recompensa-card__meta">${escapeHTML(r.descricao)}</div>` : ''}
        ${r.voucher_codigo ? `<span class="recompensa-card__codigo">${escapeHTML(r.voucher_codigo)}</span>` : ''}
        <div class="recompensa-card__meta">Atribuída em ${dataStr}</div>
      </div>
    </div>
  `;
}

$('detalhe-voltar').addEventListener('click', () => {
  showSection('utilizadores');
});

// ============================================
// PONTUAÇÕES (todos, filtrável por nível)
// ============================================

async function loadPontuacoes() {
  const wrap = $('pontuacoes-lista');
  wrap.innerHTML = '<div class="loading">A carregar…</div>';

  // Carregar níveis para o filtro (uma vez)
  const filtroNivel = $('pontuacoes-filtro-nivel');
  if (filtroNivel.options.length <= 1) {
    const { data: niveis } = await sb.from('niveis').select('id, nome').order('id');
    (niveis || []).forEach(n => {
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = n.nome;
      filtroNivel.appendChild(opt);
    });
  }

  await applyPontuacoesFiltro();
}

async function applyPontuacoesFiltro() {
  await carregarEstadosBeneficiarios();
  const wrap = $('pontuacoes-lista');
  const filtro = $('pontuacoes-filtro-nivel').value;

  let q = sb.from('resultados')
    .select('numero_beneficiario, nivel_nome, percentagem, acertos, total_perguntas, criado_em, id_nivel')
    .order('percentagem', { ascending: false })
    .order('criado_em', { ascending: false })
    .limit(100);

  if (filtro) q = q.eq('id_nivel', parseInt(filtro, 10));

  const { data, error } = await q;
  if (error) {
    wrap.innerHTML = `<div class="error">Erro: ${escapeHTML(error.message)}</div>`;
    return;
  }
  if (!data || data.length === 0) {
    wrap.innerHTML = '<div class="empty">Sem resultados para este filtro.</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>#</th><th>Beneficiário</th><th>Nível</th><th class="num">Pontuação</th><th>Data</th></tr>
      </thead>
      <tbody>
        ${data.map((r, i) => `
          <tr class="clickable" data-numero="${escapeHTML(r.numero_beneficiario)}">
            <td class="num">${i + 1}</td>
          <td>${escapeHTML(etiquetaBeneficiario(r.numero_beneficiario))}</td>
            <td>${escapeHTML(r.nivel_nome || '—')}</td>
            <td class="num">${r.percentagem}% <small>(${r.acertos}/${r.total_perguntas})</small></td>
            <td>${formatDateShort(r.criado_em)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => goToDetalheUtilizador(tr.dataset.numero));
  });
}

$('pontuacoes-filtro-nivel').addEventListener('change', applyPontuacoesFiltro);

// ============================================
// RECOMPENSAS (todas)
// ============================================

async function loadRecompensas() {
   await carregarEstadosBeneficiarios();
  const wrap = $('recompensas-lista');
  wrap.innerHTML = '<div class="loading">A carregar…</div>';

  const { data, error } = await sb.from('recompensas')
    .select('*')
    .order('criado_em', { ascending: false })
    .limit(200);

  if (error) {
    wrap.innerHTML = `<div class="error">Erro: ${escapeHTML(error.message)}</div>`;
    return;
  }
  if (!data || data.length === 0) {
    wrap.innerHTML = '<div class="empty">Ainda nenhuma recompensa atribuída.</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>Beneficiário</th><th>Tipo</th><th>Título</th><th>Código/Imagem</th><th>Data</th></tr>
      </thead>
      <tbody>
        ${data.map(r => `
          <tr class="clickable" data-numero="${escapeHTML(r.numero_beneficiario)}">
           <td><strong>${escapeHTML(etiquetaBeneficiario(r.numero_beneficiario))}</strong></td>
            <td><span class="badge badge--${r.tipo}">${r.tipo === 'voucher' ? '🎟️ Voucher' : (r.imagem_url ? '🖼️ Imagem' : '🏅 Medalha')}</span></td>
            <td>${escapeHTML(r.titulo)}</td>
            <td>${
              r.tipo === 'imagem' && r.imagem_url
                ? `<img src="${escapeHTML(r.imagem_url)}" style="width:40px;height:40px;border-radius:6px;object-fit:cover">`
                : (r.voucher_codigo ? `<code>${escapeHTML(r.voucher_codigo)}</code>` : '—')
            }</td>
            <td>${formatDateShort(r.criado_em)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => goToDetalheUtilizador(tr.dataset.numero));
  });
}

// ============================================
// MODAL: Atribuir recompensa
// ============================================

function openModalRecompensa(numero) {
  $('rec-beneficiario').textContent = numero;
  $('recompensa-form').reset();
  $('rec-imagem-preview').hidden = true;
  $('rec-error').hidden = true;
  // Default: imagem
  syncTipoUI('imagem');
  $('modal-recompensa').hidden = false;
}

function syncTipoUI(tipo) {
  $('rec-imagem-wrap').hidden = (tipo !== 'imagem');
  $('rec-voucher-wrap').hidden = (tipo !== 'voucher');
}

$$('input[name="rec-tipo"]').forEach(r => {
  r.addEventListener('change', () => syncTipoUI(r.value));
});

// Preview da imagem
$('rec-imagem').addEventListener('change', (e) => {
  const file = e.target.files[0];
  const prev = $('rec-imagem-preview');
  if (!file) { prev.hidden = true; return; }
  if (file.size > 2 * 1024 * 1024) {
    $('rec-error').textContent = 'Imagem maior que 2 MB. Reduza o tamanho.';
    $('rec-error').hidden = false;
    e.target.value = '';
    prev.hidden = true;
    return;
  }
  $('rec-error').hidden = true;
  const url = URL.createObjectURL(file);
  prev.innerHTML = `<img src="${url}" alt="Pré-visualização">`;
  prev.hidden = false;
});

// Submeter recompensa
$('recompensa-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('rec-error').hidden = true;

  const numero = $('rec-beneficiario').textContent;
  const tipo = document.querySelector('input[name="rec-tipo"]:checked').value;
  const titulo = $('rec-titulo').value.trim();
  const descricao = $('rec-descricao').value.trim();

  if (!titulo) {
    showRecError('Indique um título.');
    return;
  }

  const btn = e.submitter || e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'A guardar…';

  try {
    const row = {
      numero_beneficiario: numero,
      tipo,
      titulo,
      descricao: descricao || null,
      atribuido_por: _adminProfile?.user_id || null,
    };

    if (tipo === 'imagem') {
      const file = $('rec-imagem').files[0];
      // Imagem opcional: se houver ficheiro faz upload; sem ficheiro, fica recompensa sem imagem (medalha).
      if (file) {
        const ext = file.name.split('.').pop();
        const path = `${numero}/${Date.now()}.${ext}`;
        const { error: upErr } = await sb.storage.from('recompensas').upload(path, file);
        if (upErr) throw upErr;
        const { data: { publicUrl } } = sb.storage.from('recompensas').getPublicUrl(path);
        row.imagem_url = publicUrl;
      }
    } else {
      const codigo = $('rec-voucher-codigo').value.trim();
      if (!codigo) throw new Error('Indique o código do voucher.');
      row.voucher_codigo = codigo;
    }

    const { error } = await sb.from('recompensas').insert(row);
    if (error) throw error;

    closeModais();
    // Refrescar a vista actual
    if (_detalheNumero) await goToDetalheUtilizador(_detalheNumero);
  } catch (err) {
    showRecError('Erro: ' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Atribuir';
  }
});

function showRecError(msg) {
  $('rec-error').textContent = msg;
  $('rec-error').hidden = false;
}

// ============================================
// MODAL: Novo utilizador
// ============================================

$('utilizador-novo').addEventListener('click', () => {
  $('utilizador-form').reset();
  $('user-error').hidden = true;
  $('modal-utilizador').hidden = false;
});

$('utilizador-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('user-error').hidden = true;

  const numero = $('user-numero').value.trim();
  const ano = parseInt($('user-ano').value, 10);

  if (!numero || !ano) {
    $('user-error').textContent = 'Preencha número e ano.';
    $('user-error').hidden = false;
    return;
  }

  const btn = e.submitter || e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'A guardar…';

  const { error } = await sb.from('Utilizadores').insert({
    numbeneficiario: numero,
    anonascimento: ano,
  });

  btn.disabled = false;
  btn.textContent = 'Criar';

  if (error) {
    $('user-error').textContent = error.code === '23505'
      ? 'Já existe um utilizador com esse número.'
      : 'Erro: ' + error.message;
    $('user-error').hidden = false;
    return;
  }

  closeModais();
  await loadUtilizadores();
});

// ============================================
// MODAL — fechar
// ============================================

function closeModais() {
  $$('.modal').forEach(m => m.hidden = true);
}

$$('[data-modal-close]').forEach(el => {
  el.addEventListener('click', closeModais);
});

// Esc fecha modais
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModais();
});

// ============================================
// UTILS
// ============================================

function formatDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ============================================
// ARRANQUE
// ============================================

// ============================================
// ACESSIBILIDADE
// ============================================

const A11Y_KEY = 'mais_saude_a11y_prefs';
const A11Y_FLAGS = ['largeText', 'highContrast', 'reducedMotion', 'readAloud'];

const A11y = {
  load() {
    try {
      const raw = localStorage.getItem(A11Y_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  },
  save(prefs) { try { localStorage.setItem(A11Y_KEY, JSON.stringify(prefs)); } catch {} },
  apply(prefs) {
    document.body.classList.toggle('a11y-large-text', !!prefs.largeText);
    document.body.classList.toggle('a11y-high-contrast', !!prefs.highContrast);
    document.body.classList.toggle('a11y-reduced-motion', !!prefs.reducedMotion);
    const ttsBtn = document.getElementById('tts-btn');
    if (ttsBtn) {
      ttsBtn.hidden = !prefs.readAloud;
      if (!prefs.readAloud) {
        try { TTS.stop(); } catch (e) { /* TTS ainda não inicializado */ }
      }
    }
  },
  set(flag, value) {
    const prefs = this.load();
    prefs[flag] = !!value;
    this.save(prefs);
    this.apply(prefs);
  },
  init() {
    const prefs = this.load();
    this.apply(prefs);
    A11Y_FLAGS.forEach(flag => {
      const id = 'a11y-' + flag.replace(/([A-Z])/g, '-$1').toLowerCase();
      const el = document.getElementById(id);
      if (!el) return;
      el.checked = !!prefs[flag];
      el.addEventListener('change', () => {
        A11y.set(flag, el.checked);
        announce(el.checked ? 'Preferência ativada.' : 'Preferência desativada.');
      });
    });
  },
};

A11y.apply(A11y.load());
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => A11y.init());
} else {
  A11y.init();
}

function announce(msg) {
  const el = document.getElementById('a11y-announcer');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = msg; }, 50);
}

// ============================================
// LEITURA EM VOZ ALTA (TTS)
// ============================================

const TTS = {
  speaking: false,
  isSupported() { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; },
  toggle() { if (this.speaking) this.stop(); else this.start(); },
  start() {
    if (!this.isSupported()) { announce('Síntese de voz não suportada.'); return; }
    // No admin a vista actual é a secção visível dentro do main
    const section = document.querySelector('.admin-section:not([hidden])') ||
                    document.querySelector('.admin-view:not([hidden])');
    if (!section) return;
    const text = this._extractText(section);
    if (!text.trim()) { announce('Nada para ler.'); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-PT';
    u.rate = 1.0;
    u.onend = () => { this.speaking = false; this._updateButton(); };
    u.onerror = () => { this.speaking = false; this._updateButton(); };
    u.onstart = () => { this.speaking = true; this._updateButton(); };
    window.speechSynthesis.speak(u);
    this.speaking = true;
    this._updateButton();
  },
  stop() {
    if (this.isSupported()) window.speechSynthesis.cancel();
    this.speaking = false;
    this._updateButton();
  },
  _extractText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[hidden]')) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.sr-only')) return NodeFilter.FILTER_REJECT;
        if (parent.closest('script,style,noscript')) return NodeFilter.FILTER_REJECT;
        const txt = node.textContent.trim();
        if (!txt) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const parts = [];
    let n;
    while ((n = walker.nextNode())) parts.push(n.textContent.trim());
    return parts.join('. ').replace(/\.\s*\./g, '.').replace(/\s+/g, ' ');
  },
  _updateButton() {
    const btn = document.getElementById('tts-btn');
    if (!btn) return;
    btn.textContent = this.speaking ? '⏸' : '🔊';
    btn.classList.toggle('tts-btn--speaking', this.speaking);
    btn.setAttribute('aria-label', this.speaking ? 'Parar leitura' : 'Ouvir esta página');
  },
};

function bindTTS() {
  const btn = document.getElementById('tts-btn');
  if (btn) btn.addEventListener('click', () => TTS.toggle());
  // Parar leitura ao mudar de secção (admin-section ou admin-view)
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName === 'hidden') { TTS.stop(); break; }
    }
  });
  document.querySelectorAll('.admin-section, .admin-view').forEach(el => {
    obs.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindTTS);
else bindTTS();

// Botão de acessibilidade no header abre o modal
$('admin-a11y-trigger').addEventListener('click', () => {
  $('modal-a11y').hidden = false;
});

// ============================================
// INSTALAR APP — PWA install
// ============================================

let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  const card = document.getElementById('admin-install-card');
  if (card) card.hidden = false;
});

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function isInStandaloneMode() {
  return ('standalone' in window.navigator && window.navigator.standalone) ||
         window.matchMedia('(display-mode: standalone)').matches;
}

function refreshInstallCardAdmin() {
  const card = document.getElementById('admin-install-card');
  if (!card) return;
  if (isInStandaloneMode()) { card.hidden = true; return; }
  if (_deferredInstallPrompt || isIOS()) { card.hidden = false; return; }
  card.hidden = true;
}

const installBtn = document.getElementById('admin-install-btn');
if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (isIOS()) {
      $('ios-install-modal').hidden = false;
      return;
    }
    if (!_deferredInstallPrompt) {
      announce('Instalação não disponível neste browser.');
      return;
    }
    _deferredInstallPrompt.prompt();
    const { outcome } = await _deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      announce('Painel instalado.');
      document.getElementById('admin-install-card').hidden = true;
    }
    _deferredInstallPrompt = null;
  });
}

window.addEventListener('appinstalled', () => {
  const card = document.getElementById('admin-install-card');
  if (card) card.hidden = true;
});

// ============================================
// Service Worker
// ============================================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ============================================
// ARRANQUE
// ============================================

(async function init() {
  await checkSession();
  // Re-init a11y depois do DOM estar populado (caso o modal não estivesse pronto antes)
  A11y.init();
  refreshInstallCardAdmin();
})();


// ============================================================
// ⚠️ INÍCIO — BLOCO TEMPORÁRIO: LIMPAR DADOS DE TESTE
//    Apaga resultados + recompensas + consents. MANTÉM os beneficiários.
//    Backend: RPC limpar_dados_de_teste(p_confirmacao).
//    >>> Para remover depois do lançamento: apagar tudo entre INÍCIO e FIM. <
// ============================================================
(function () {
  const FRASE = 'APAGAR DADOS DE TESTE';
  const alvo = document.getElementById('section-dashboard');
if (!alvo || document.getElementById('btn-limpar-historico')) return;

  alvo.insertAdjacentHTML('beforeend', `
    <div class="admin-card" style="border:2px dashed #c00000;background:#fff6f6;margin-top:2rem">
      <<h3 style="color:#c00000">⚠️ Temporário — apagar TODO o histórico</h3>
    <p class="hint">Apaga <strong>todos os resultados de quiz, recompensas e consentimentos</strong> — de <strong>todos</strong> os beneficiários, reais incluídos, e não apenas dos de teste. Os beneficiários são <strong>mantidos</strong>, com registo limpo. Para limpar só os fictícios, usa o botão em Utilizadores. Ação irreversível.</p>
     <button id="btn-limpar-historico" class="btn btn--secondary btn--small" type="button">Apagar todo o histórico…</button>
    </div>
  `);

  ddocument.getElementById('btn-limpar-historico').addEventListener('click', async () => {
    const escrito = prompt(
      'Esta acao e IRREVERSIVEL.\n\n' +
      'Apaga TODOS os resultados, recompensas e consentimentos.\n' +
      'Os beneficiarios sao mantidos.\n\n' +
      'Para confirmar, escreva exatamente:\n\n' + FRASE
    );
    if (escrito === null) return;
    if (escrito.trim() !== FRASE) { alert('A frase nao coincide. Acao cancelada.'); return; }

    const b = document.getElementById('btn-limpar-historico');
    b.disabled = true; b.textContent = 'A limpar…';
    try {
      const { data, error } = await sb.rpc('limpar_dados_de_teste', { p_confirmacao: escrito.trim() });
      if (error) throw error;
      alert(
        'Base de teste limpa.\n\n' +
        'Resultados apagados: '     + data.resultados_apagados  + '\n' +
        'Recompensas apagadas: '    + data.recompensas_apagadas + '\n' +
        'Consentimentos apagados: ' + data.consents_apagados
      );
      if (typeof loadDashboard === 'function') await loadDashboard();
    } catch (err) {
      alert('Erro: ' + (err.message || err));
    } finally {
     b.disabled = false; b.textContent = 'Apagar todo o histórico…';
    }
  });
})();
// ============================================================
// ⚠️ FIM — BLOCO TEMPORÁRIO: LIMPAR DADOS DE TESTE
// ============================================================

// ============================================================
// CONTEÚDO — importar níveis + perguntas do Google Sheets
// ============================================================

const SHEET_CSV_NIVEIS   = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSpQiQ_MWPfMCIuG-WYuPeJrNKCTKIpBrjRi_fC5N9F9cuL88PwxLS_5nzsFmycMpeE8yAWzPpBDLVP/pub?gid=1068883762&single=true&output=csv';
const SHEET_CSV_QUESTOES = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSpQiQ_MWPfMCIuG-WYuPeJrNKCTKIpBrjRi_fC5N9F9cuL88PwxLS_5nzsFmycMpeE8yAWzPpBDLVP/pub?gid=0&single=true&output=csv';

// Parser CSV robusto: aspas, vírgulas dentro de campos, aspas duplas escapadas, \r\n e BOM.
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', i = 0, inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// CSV -> array de objetos, mapeando pelas colunas do cabeçalho (a ordem não importa).
function csvToObjects(text) {
  const rows = parseCSV(text).filter(r => r.some(c => c.trim() !== ''));
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, idx) => { o[h] = (r[idx] == null ? '' : r[idx]).trim(); });
    return o;
  });
}

async function fetchCSV(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return csvToObjects(await res.text());
}

let _conteudoBuffer = null; // { niveis:[], questoes:[] }

async function preverImportacao() {
  const btn = $('conteudo-preview');
  const out = $('conteudo-resultado');
  const conf = $('conteudo-confirmar');
  conf.hidden = true;
  _conteudoBuffer = null;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'A ler a folha…';
  out.hidden = false;
  out.innerHTML = 'A ler a Google Sheet…';

  try {
    const [niveisRaw, questoesRaw] = await Promise.all([
      fetchCSV(SHEET_CSV_NIVEIS),
      fetchCSV(SHEET_CSV_QUESTOES),
    ]);

    const problemas = [];

    const niveis = [];
    niveisRaw.forEach((n, idx) => {
      const linha = idx + 2;
      const id = parseInt(n.id, 10);
      if (!Number.isInteger(id)) { problemas.push('Níveis, linha ' + linha + ': id inválido ("' + n.id + '").'); return; }
      if (!n.nome) { problemas.push('Níveis, linha ' + linha + ': falta o nome.'); return; }
      niveis.push({
        id: id,
        nome: n.nome,
        ordem: n.ordem === '' ? null : parseInt(n.ordem, 10),
        num_perguntas: n.num_perguntas === '' ? 5 : parseInt(n.num_perguntas, 10),
      });
    });

    const questoes = [];
    questoesRaw.forEach((q, idx) => {
      const linha = idx + 2;
      const id = parseInt(q.id, 10);
      const idn = parseInt(q.id_niveis, 10);
      const corr = parseInt(q.opcao_correta, 10);
      if (!Number.isInteger(id)) { problemas.push('Perguntas, linha ' + linha + ': id inválido.'); return; }
      if (!Number.isInteger(idn)) { problemas.push('Perguntas, linha ' + linha + ': id_niveis inválido.'); return; }
      if (!q.questao) { problemas.push('Perguntas, linha ' + linha + ': falta o texto da pergunta.'); return; }
      if (![1, 2, 3].includes(corr)) { problemas.push('Perguntas, linha ' + linha + ': opcao_correta tem de ser 1, 2 ou 3.'); return; }
      questoes.push({
        id: id, id_niveis: idn, questao: q.questao,
        opcao_1: q.opcao_1, opcao_2: q.opcao_2, opcao_3: q.opcao_3,
        opcao_correta: corr,
      });
    });

    _conteudoBuffer = { niveis: niveis, questoes: questoes };

    let html = '<p><strong>' + niveis.length + '</strong> níveis · <strong>' + questoes.length + '</strong> perguntas prontas a importar.</p>';
    if (problemas.length) {
      html += '<p style="color:#D8394A;font-weight:600;margin-top:10px">⚠ ' + problemas.length + ' linha(s) ignorada(s):</p>' +
        '<ul style="margin:6px 0;padding-left:20px;color:#D8394A">' +
        problemas.map(p => '<li>' + escapeHTML(p) + '</li>').join('') + '</ul>';
    }
    if (niveis.length === 0 && questoes.length === 0) {
      html += '<p style="color:#D8394A;font-weight:600">Nada válido para importar.</p>';
    }
    out.innerHTML = html;
    conf.hidden = (niveis.length === 0 && questoes.length === 0);
  } catch (e) {
    out.innerHTML = '<p style="color:#D8394A;font-weight:600">Não foi possível ler a folha: ' + escapeHTML(e.message) + '.<br>' +
      'Confirma que as duas tabs estão publicadas como CSV (Ficheiro → Partilhar → Publicar na Web).</p>';
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function confirmarImportacao() {
  if (!_conteudoBuffer) return;
  const conf = $('conteudo-confirmar');
  const out = $('conteudo-resultado');
  conf.disabled = true;
  const orig = conf.textContent;
  conf.textContent = 'A importar…';
  try {
    const { data, error } = await sb.rpc('sincronizar_conteudo', {
      p_niveis: _conteudoBuffer.niveis,
      p_questoes: _conteudoBuffer.questoes,
    });
    if (error) throw error;
    out.innerHTML = '<p style="color:#1F7A6E;font-weight:600">✓ Importado: ' +
      data.niveis_sincronizados + ' níveis, ' + data.questoes_sincronizadas + ' perguntas.</p>';
    conf.hidden = true;
    _conteudoBuffer = null;
  } catch (e) {
    out.innerHTML += '<p style="color:#D8394A;font-weight:600">Erro ao importar: ' + escapeHTML(e.message) + '.</p>';
  } finally {
    conf.disabled = false;
    conf.textContent = orig;
  }
}

const _cp = $('conteudo-preview');
if (_cp) _cp.addEventListener('click', preverImportacao);
const _cc = $('conteudo-confirmar');
if (_cc) _cc.addEventListener('click', confirmarImportacao);
