/* 
   MAIS SAÚDE — Lógica da aplicação
 */

// ============================================
// CONFIGURAÇÃO
// ============================================

const SUPABASE_URL = 'https://hhozgecuyczrbvyzvaoz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhob3pnZWN1eWN6cmJ2eXp2YW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY4MjA1NjUsImV4cCI6MjA2MjM5NjU2NX0.26C81920FzVHVCp6OFqCUhoo6NfDnVnTZhskVNuR5qo';

// Login real-only — consulta verificar_beneficiario no Supabase
const REQUIRE_LOGIN = true;
const SESSION_KEY  = 'mais_saude_user';
const WELCOMED_KEY = 'mais_saude_welcomed';

// ============================================
// Rede de segurança: erros de JS aparecem no topo
// ============================================

function showFatalError(msg) {
  let bar = document.getElementById('__fatal');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = '__fatal';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#D8394A;color:#fff;padding:10px 14px;font:14px/1.4 system-ui,sans-serif;z-index:9999;text-align:center;';
    document.body.appendChild(bar);
  }
  bar.textContent = msg;
}
window.addEventListener('error', e => showFatalError('Erro: ' + e.message));
window.addEventListener('unhandledrejection', e => showFatalError('Erro: ' + (e.reason?.message || e.reason)));

if (!window.supabase || !window.supabase.createClient) {
  showFatalError('Biblioteca Supabase não carregou. Verifique a sua ligação.');
  throw new Error('Supabase library not loaded');
}

// === NOVO: verificar que crypto e consent estão disponíveis ===
if (!window.QMSCrypto || !window.QMSConsent) {
  showFatalError('Módulos de segurança não carregaram. Verifique o seu HTML.');
  throw new Error('QMSCrypto/QMSConsent not loaded — confirme que crypto.js e consent.js estão no HTML antes de app.js');
}
// === FIM NOVO ===

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================
// Estado da aplicação
// ============================================

const state = {
  user: null,         // { numbeneficiario: '...' }
  niveis: [],
  currentLevel: null,
  questions: [],
  qIndex: 0,
  correctCount: 0,
};

// ============================================
// Helpers
// ============================================

function $(id) { return document.getElementById(id); }

function showView(name) {
  document.querySelectorAll('[data-view]').forEach(v => {
    v.hidden = v.dataset.view !== name;
  });
  window.scrollTo(0, 0);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function escapeHTML(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${dias[d.getDay()]}, ${d.getDate()} ${meses[d.getMonth()]}`;
}

// ============================================
// Sessão e welcome flag
// ============================================

// === NOVO: saveSession agora aceita também o ano de nascimento, ===
// ===       guardado junto à sessão para re-derivar a chave de    ===
// ===       encriptação ao restaurar sessão entre refreshes.      ===
function saveSession(user, anoNascimento) {
  const toSave = (anoNascimento != null)
    ? { ...user, ano_nascimento: anoNascimento }
    : user;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(toSave)); } catch(_) {}
  state.user = toSave;
}
// === FIM NOVO ===

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) { state.user = JSON.parse(raw); return true; }
  } catch(_) {}
  return false;
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch(_) {}
  state.user = null;
}
function hasWelcomed() {
  try { return localStorage.getItem(WELCOMED_KEY) === '1'; } catch(_) { return false; }
}
function markWelcomed() {
  try { localStorage.setItem(WELCOMED_KEY, '1'); } catch(_) {}
}

function userNumber() {
  return state.user?.numbeneficiario || state.user?.numero_beneficiario || '';
}

// ===lista de chaves localStorage sensíveis a encriptar ===
function sensitiveStorageKeys() {
  const num = userNumber() || 'anon';
  return [
    `mais_saude_${num}_tomas`,
    `mais_saude_${num}_medicoes`,
    `mais_saude_${num}_nome`,
  ];
}
// === FIM NOVO ===

// ============================================
// LOGIN
// ============================================

const loginForm  = $('login-form');
const loginError = $('login-error');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;

  const numero = loginForm.numero.value.trim();
  const ano = parseInt(loginForm.ano.value, 10);

  if (!numero || !ano) {
    showLoginError('Preencha o número e o ano de nascimento.');
    return;
  }

  if (!REQUIRE_LOGIN) {
    saveSession({ numbeneficiario: numero, modo_teste: true }, ano);
    // === NOVO: derivar chave e migrar dados também em modo de teste ===
    try {
      await window.QMSCrypto.deriveSessionKey(numero, ano);
      await window.QMSCrypto.migrateToEncrypted(sensitiveStorageKeys());
    } catch (err) {
      console.warn('Crypto setup falhou em modo teste:', err);
    }
    // === FIM NOVO ===
    await goToDashboard();
    return;
  }

  try {
    const { data, error } = await sb.rpc('verificar_beneficiario', {
      p_numero: numero, p_ano: ano,
    });
    if (error) throw error;
  if (!data || data.length === 0) {
      // Distinguir "dados errados" de "consentimento retirado".
      // So revela o estado a quem acerta no numero E no ano (as mesmas
      // credenciais que dariam acesso normal) — nao permite enumeracao.
      // TEXTO PROVISORIO: a aguardar redacao final da Dignitude.
      let retirado = false;
      try {
        const r = await sb.rpc('consentimento_retirado', {
          p_numero: numero, p_ano: ano,
        });
        retirado = (r.data === true);
      } catch (err) {
        console.warn('Nao foi possivel verificar o estado do consentimento:', err);
      }
      showLoginError(retirado
        ? 'O acesso está suspenso porque o consentimento foi retirado. Para voltar a usar a aplicação, contacte a Dignitude.'
        : 'Número de beneficiário ou ano de nascimento inválidos.');
      return;
    }

    // === NOVO: derivar chave + migrar dados + verificar consentimento ===
    const verifiedPin = data[0].numbeneficiario || data[0].numero_beneficiario || numero;

    // Guardar sessão temporariamente para que userNumber() devolva o PIN
    // (necessário para sensitiveStorageKeys() abaixo)
    saveSession(data[0], ano);

    try {
      await window.QMSCrypto.deriveSessionKey(verifiedPin, ano);
      await window.QMSCrypto.migrateToEncrypted(sensitiveStorageKeys());
    } catch (err) {
      console.error('Erro a configurar encriptação:', err);
      clearSession();
      showLoginError('Erro a inicializar segurança da sessão. Tente novamente.');
      return;
    }

    // Verificar/pedir consentimento — bloqueia entrada se o utilizador recusar
    try {
      const consent = await window.QMSConsent.ensureConsent(verifiedPin, sb);
      if (!consent) {
        window.QMSCrypto.lockSession();
        clearSession();
        showLoginError('É necessário aceitar os termos de privacidade para usar a app.');
        return;
      }
    } catch (err) {
      window.QMSCrypto.lockSession();
      clearSession();
      showLoginError(err.message || 'Erro a registar o consentimento.');
      return;
    }
    // === FIM NOVO ===

    await goToDashboard();
  } catch (err) {
    console.error('Login error:', err);
    showLoginError('Erro ao verificar credenciais. Tente novamente.');
  }
});

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.hidden = false;
}

// ============================================
// WELCOME
// ============================================

$('welcome-start').addEventListener('click', () => {
  markWelcomed();
  showView('login');
});

// ============================================
// DASHBOARD
// ============================================

async function goToDashboard() {
  showView('dashboard');
  await loadDashboard();
}

async function loadDashboard() {
  const num = userNumber();
  // === NOVO: getUserName agora é async ===
  const nome = await getUserName();
  // === FIM NOVO ===
  $('dashboard-user').textContent = nome || num;

  // Pre-carregar pontuação enquanto carrega níveis em segundo plano
  $('stat-quizzes').textContent = '…';
  $('stat-media').textContent = '…';

  const stats = await loadUserStats(num);
  $('stat-quizzes').textContent = stats.total;
  $('stat-media').textContent = stats.total > 0 ? `${stats.media}%` : '—';

  // Carregar agendamentos e mostrar próxima toma
  await renderProximaToma();
   renderRecompensaBanner().catch(() => {});

  // Preload níveis em background para abrir mais depressa quando carregar no Iniciar Quiz
  loadNiveis().catch(() => {});
}

// ====== Aviso de recompensa nova (banner no painel) ======
function recompensasVistasKey() {
  const n = userNumber() || 'anon';
  return `mais_saude_${n}_recompensas_vistas`;
}
function getRecompensasVistas() {
  try { return parseInt(localStorage.getItem(recompensasVistasKey()) || '0', 10) || 0; }
  catch { return 0; }
}
function setRecompensasVistas(n) {
  try { localStorage.setItem(recompensasVistasKey(), String(n)); } catch {}
}
async function renderRecompensaBanner() {
  const banner = document.getElementById('recompensa-banner');
  if (!banner) return;
  const num = userNumber();
  if (!num) { banner.hidden = true; return; }
  let total = 0;
  try {
    const { data, error } = await sb.rpc('get_recompensas', { p_pin: num });
    if (error || !data) { banner.hidden = true; return; }
    total = data.length;
  } catch { banner.hidden = true; return; }
  const novas = total - getRecompensasVistas();
  if (novas > 0) {
    document.getElementById('recompensa-banner-text').textContent =
      novas === 1 ? 'Tens 1 recompensa nova!' : `Tens ${novas} recompensas novas!`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}
(function bindRecompensaBanner() {
  const btn = document.getElementById('recompensa-banner-btn');
  if (btn) btn.addEventListener('click', () => goToPerfil());
})();

async function loadUserStats(numero) {
  if (!numero) return { total: 0, media: 0 };
  const { data, error } = await sb.rpc('get_resultados', { p_pin: numero, p_limite: 100000 });
  if (error || !data) {
    console.warn('Erro ao carregar stats:', error);
    return { total: 0, media: 0 };
  }
  const total = data.length;
  const media = total > 0
    ? Math.round(data.reduce((acc, r) => acc + (r.percentagem || 0), 0) / total)
    : 0;
  return { total, media };
}

$('dashboard-quiz').addEventListener('click', () => goToNiveis());
$('dashboard-medicamentos').addEventListener('click', () => goToMedicamentos());
$('dashboard-historico').addEventListener('click', () => goToHistorico());
$('dashboard-perfil').addEventListener('click', () => goToPerfil());
$('dashboard-perfil-card').addEventListener('click', () => goToPerfil());

// ============================================
// NÍVEIS
// ============================================

async function goToNiveis() {
  showView('niveis');
  await loadNiveis();
  renderNiveis();
}

async function loadNiveis() {
  const { data, error } = await sb.rpc('get_estado_percurso', {
    p_pin: userNumber(),
  });
  if (error) {
    $('niveis-list').innerHTML = `<li class="loading">Não foi possível carregar os níveis.<small>${escapeHTML(error.message)}</small></li>`;
    return;
  }
  state.niveis = data || [];
}

function renderNiveis() {
  const list = $('niveis-list');
  if (state.niveis.length === 0) {
    list.innerHTML = '<li class="loading">Ainda não há níveis disponíveis.</li>';
    return;
  }
  list.innerHTML = state.niveis.map((n, i) => {
    const total = n.total_perguntas || 0;
    const feitas = n.respondidas || 0;
    const melhor = (n.melhor_percentagem != null) ? ` · melhor ${n.melhor_percentagem}%` : '';
    const nome = n.nome || `Nível ${i + 1}`;
    const bloqueado = (n.desbloqueado === false);
    const anterior = (i > 0 && state.niveis[i - 1])
      ? (state.niveis[i - 1].nome || `Nível ${i}`)
      : '';
    const progresso = bloqueado
      ? (anterior ? `Conclua o ${anterior} para desbloquear` : 'Ainda bloqueado')
      : (n.esgotado ? `Concluído${melhor}` : `${feitas} de ${total} respondidas${melhor}`);
    const classes = 'nivel-item'
      + (n.esgotado && !bloqueado ? ' is-done' : '')
      + (bloqueado ? ' is-locked' : '');
    const marca = bloqueado ? '🔒' : (n.esgotado ? '✓' : i + 1);
    return `
    <li class="${classes}" tabindex="0" role="button"${bloqueado ? ' aria-disabled="true"' : ''}
        data-nivel-id="${n.id}"
        data-nivel-nome="${escapeHTML(nome)}"
        data-bloqueado="${bloqueado ? '1' : '0'}">
      <span class="nivel-number" aria-hidden="true">${marca}</span>
      <span class="nivel-body">
        <span class="nivel-name">${escapeHTML(nome)}</span>
        <span class="nivel-progress">${progresso}</span>
      </span>
      <span class="nivel-arrow" aria-hidden="true">${bloqueado ? '' : '→'}</span>
    </li>`;
  }).join('');
  list.querySelectorAll('.nivel-item').forEach(item => {
    if (item.dataset.bloqueado === '1') return;
    const open = () => startQuiz({
      id: parseInt(item.dataset.nivelId, 10),
      nome: item.dataset.nivelNome,
    });
    item.addEventListener('click', open);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });

  const todosFeitos = state.niveis.length > 0 && state.niveis.every(n => n.esgotado);
  const cap = document.querySelector('.niveis-intro .caption');
  if (cap) cap.textContent = todosFeitos
    ? '🎉 Parabéns! Já respondeste a todas as perguntas de todos os níveis.'
    : 'Toque num nível para começar.';
}

$('niveis-back').addEventListener('click', () => goToDashboard());

// ============================================
// QUIZ
// ============================================

async function startQuiz(nivel) {
  state.currentLevel = nivel;
  state.qIndex = 0;
  state.correctCount = 0;
  state.answers = [];
  $('quiz-level-name').textContent = nivel.nome;
  $('question-text').textContent = 'A carregar…';
  $('options').innerHTML = '';
  $('progress-fill').style.width = '0%';
  const _pt = document.querySelector('[data-view="quiz"] .progress-text');
  const _pb = document.querySelector('[data-view="quiz"] .progress-bar');
  if (_pt) _pt.hidden = false;
  if (_pb) _pb.hidden = false;
  showView('quiz');

  const { data, error } = await sb.rpc('obter_perguntas_do_nivel', {
    p_pin: userNumber(),
    p_nivel: nivel.id,
  });
  if (error) {
    $('question-text').textContent = 'Erro ao carregar perguntas.';
    return;
  }
  state.questions = data || [];
  if (state.questions.length === 0) {
    $('question-text').textContent = 'Já respondeste a todas as perguntas deste nível. 🎉';
    $('options').innerHTML = '';
    $('feedback').hidden = true;
    $('quiz-next').hidden = true;
    if (_pt) _pt.hidden = true;
    if (_pb) _pb.hidden = true;
    return;
  }
  $('q-total').textContent = state.questions.length;
  renderQuestion();
}

function renderQuestion() {
  const q = state.questions[state.qIndex];
  $('question-text').textContent = q.questao || `Pergunta ${state.qIndex + 1}`;
  $('q-current').textContent = state.qIndex + 1;
  $('progress-fill').style.width = `${(state.qIndex / state.questions.length) * 100}%`;
  const feedback = $('feedback');
  feedback.hidden = true;
  feedback.className = 'feedback';
  $('quiz-next').hidden = true;

  const letters = ['A', 'B', 'C', 'D'];
  const opts = [
    { texto: q.opcao_1, num: 1 },
    { texto: q.opcao_2, num: 2 },
    { texto: q.opcao_3, num: 3 },
  ].filter(o => o.texto != null && String(o.texto).trim() !== '');

  const optionsEl = $('options');
  optionsEl.innerHTML = opts.map((o, i) => `
    <li class="option" data-num="${o.num}" tabindex="0" role="button">
      <span class="option__letter">${letters[i]}</span>
      <span class="option__text">${escapeHTML(o.texto)}</span>
    </li>
  `).join('');
  optionsEl.querySelectorAll('.option').forEach(opt => {
    const choose = () => answer(parseInt(opt.dataset.num, 10), opt);
    opt.addEventListener('click', choose);
    opt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
    });
  });
}

function answer(chosen, chosenEl) {
 const q = state.questions[state.qIndex];
  const correct = q.opcao_correta;
  state.answers.push({ id_questao: q.id, escolhida: chosen });
  document.querySelectorAll('.option').forEach(o => o.classList.add('option--disabled'));

  if (chosen === correct) {
    chosenEl.classList.add('option--correct');
    state.correctCount++;
    showFeedback('✓  Resposta correta!', 'success');
  } else {
    chosenEl.classList.add('option--wrong');
    const correctEl = document.querySelector(`.option[data-num="${correct}"]`);
    if (correctEl) correctEl.classList.add('option--correct');
    showFeedback('✗  A resposta certa está realçada a verde.', 'error');
  }

const nextBtn = $('quiz-next');
  nextBtn.hidden = false;
  nextBtn.focus();
}

function showFeedback(text, kind) {
  const fb = $('feedback');
  fb.textContent = text;
  fb.className = `feedback feedback--${kind === 'success' ? 'success' : 'error'}`;
  fb.hidden = false;
}

$('quiz-back').addEventListener('click', () => goToNiveis());

$('quiz-next').addEventListener('click', () => {
  $('quiz-next').hidden = true;
  state.qIndex++;
  if (state.qIndex >= state.questions.length) {
    finishLevel();
  } else {
    renderQuestion();
  }
});


// RESULTADO + Guardar no Supabase


async function finishLevel() {
  $('progress-fill').style.width = '100%';

  const total = state.questions.length;
  const correct = state.correctCount;
  const percent = total > 0 ? Math.round((correct / total) * 100) : 0;

  // Mensagem motivacional consoante a percentagem
  let msg;
  if (percent === 100) msg = 'Perfeito! 🎉';
  else if (percent >= 80) msg = 'Excelente trabalho!';
  else if (percent >= 60) msg = 'Bom resultado!';
  else if (percent >= 40) msg = 'Continue a praticar.';
  else msg = 'Pode melhorar — tente de novo.';

  $('resultado-percent').textContent = `${percent}%`;
  $('resultado-detail').textContent = `${correct} de ${total} respostas corretas`;
  $('resultado-msg').textContent = msg;

  // O botão do nível seguinte só nasce depois de a tentativa estar gravada:
  // é essa gravação que desbloqueia o nível seguinte na base de dados.
  $('resultado-next').hidden = true;

  showView('resultado');

  try {
    await saveResultado({
      numero_beneficiario: userNumber(),
      id_nivel: state.currentLevel.id,
      nivel_nome: state.currentLevel.nome,
      total_perguntas: total,
      acertos: correct,
      percentagem: percent,
    });
    await loadNiveis();
  } catch (err) {
    console.warn('Não foi possível guardar o resultado:', err);
  }

  const idx = state.niveis.findIndex(n => n.id === state.currentLevel.id);
  const seguinte = (idx >= 0) ? state.niveis[idx + 1] : null;
  $('resultado-next').hidden = !(seguinte && seguinte.desbloqueado !== false);
}

async function saveResultado(row) {
  if (!row.numero_beneficiario) return;
  const { error } = await sb.rpc('registar_tentativa', {
    p_pin: row.numero_beneficiario,
    p_id_nivel: row.id_nivel,
    p_nivel_nome: row.nivel_nome,
    p_respostas: state.answers,
  });
  if (error) console.warn('Erro ao registar tentativa:', error);
}

$('resultado-next').addEventListener('click', () => {
  const currentIdx = state.niveis.findIndex(n => n.id === state.currentLevel.id);
  const next = state.niveis[currentIdx + 1];
  if (next) startQuiz(next); else goToDashboard();
});

$('resultado-home').addEventListener('click', () => goToDashboard());

// ============================================
// HISTÓRICO
// ============================================

async function goToHistorico() {
  showView('historico');
  await loadHistorico();
}

async function loadHistorico() {
  const list = $('historico-list');
  list.innerHTML = '<li class="loading">A carregar…</li>';
  const { data, error } = await sb.rpc('get_resultados', { p_pin: userNumber(), p_limite: 100000 });

  if (error) {
    list.innerHTML = `<li class="loading">Erro ao carregar histórico.<small>${escapeHTML(error.message)}</small></li>`;
    return;
  }
  if (!data || data.length === 0) {
    list.innerHTML = '<li class="historico-empty">Ainda não fez nenhum quiz. Comece um agora!</li>';
    return;
  }
  list.innerHTML = data.map(r => `
    <li class="historico-item">
      <span class="historico-item__date">${escapeHTML(formatDate(r.criado_em))}</span>
      <span class="historico-item__name">${escapeHTML(r.nivel_nome || 'Quiz')}</span>
      <span class="historico-item__percent">${r.percentagem}%</span>
    </li>
  `).join('');
}

$('historico-back').addEventListener('click', () => goToDashboard());

// ============================================
// PERFIL
// ============================================

// Nome personalizado guardado localmente por número de beneficiário
function userNameKey() {
  const n = userNumber() || 'anon';
  return `mais_saude_${n}_nome`;
}

// === NOVO: getUserName/setUserName passam a usar encriptação ===
async function getUserName() {
  try {
    const v = await window.QMSCrypto.secureGet(userNameKey());
    return v || '';
  } catch { return ''; }
}
async function setUserName(nome) {
  try {
    const trimmed = nome && nome.trim() ? nome.trim().slice(0, 40) : '';
    if (trimmed) {
      await window.QMSCrypto.secureSet(userNameKey(), trimmed);
    } else {
      localStorage.removeItem(userNameKey());
    }
  } catch (err) { console.warn('Falha a guardar nome:', err); }
}
// === FIM NOVO ===

async function goToPerfil() {
  showView('perfil');
  $('perfil-numero').textContent = userNumber() || '—';
  // === NOVO: getUserName agora async ===
  $('perfil-nome').value = await getUserName();
  // === FIM NOVO ===

  const stats = await loadUserStats(userNumber());
  $('perfil-total-quizzes').textContent = stats.total;
  $('perfil-media').textContent = stats.total > 0 ? `${stats.media}%` : '—';

  renderPerfilNotif();
  // === NOVO: carregar secção de consentimento ===
  loadConsentSection().catch(err => console.warn('Erro consent section:', err));
  // === FIM NOVO ===
  renderPerfilRecompensas().catch(err => console.warn('Erro a carregar recompensas:', err));
  if (typeof refreshInstallCard === 'function') refreshInstallCard();
}

// Guardar nome ao perder foco (blur) e ao premir Enter
(function bindNomeInput() {
  function bind() {
    const inp = document.getElementById('perfil-nome');
    if (!inp) return;
    // === NOVO: handler async para usar await setUserName ===
    inp.addEventListener('blur', async () => {
      await setUserName(inp.value);
      announce('Nome guardado.');
    });
    // === FIM NOVO ===
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

// === NOVO: gestão da secção de consentimento no perfil ===
async function loadConsentSection() {
  const pin = userNumber();
  const card = document.getElementById('perfil-consent');
  if (!card) return;          // se ainda não adicionaste o HTML, ignora
  const statusEl = document.getElementById('perfil-consent-status');
  if (!pin) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  try {
    const consent = await window.QMSConsent.getConsentStatus(pin, sb);
    if (consent) {
     const grantedDate = new Date(consent.granted_at).toLocaleDateString('pt-PT');
      statusEl.textContent = `Registo de informação desde ${grantedDate}.`;
    } else {
      statusEl.textContent = 'Sem consentimento ativo.';
    }
  } catch (err) {
    statusEl.textContent = 'Não foi possível verificar o estado do consentimento.';
  }
}

// Wire-up do botão "Retirar consentimento"
(function bindConsentWithdraw() {
  function bind() {
    const btn = document.getElementById('perfil-consent-withdraw');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const confirmed = confirm(
        'Vai retirar o seu consentimento e sair da app. Os resultados de quiz e recompensas deixam de estar associados a si. '
        + 'Para apagar ou anonimizar totalmente os seus dados, contacte geral@dignitude.org. Quer continuar?'
      );
      if (!confirmed) return;
      const pin = userNumber();
      if (!pin) return;
      btn.disabled = true;
      btn.textContent = 'A processar…';
      try {
        const success = await window.QMSConsent.withdrawConsent(pin, sb);
        if (success) {
          alert('O seu consentimento foi retirado. Vai sair da app.');
          window.QMSCrypto.lockSession();
          Notifications._clearTimers();
          clearSession();
          invalidateMedCaches();
          loginForm.reset();
          showView('login');
        } else {
          alert('Não foi possível processar o pedido. Tente novamente mais tarde.');
          btn.disabled = false;
          btn.textContent = 'Retirar consentimento';
        }
      } catch (err) {
        alert('Erro ao processar o pedido: ' + (err.message || err));
        btn.disabled = false;
        btn.textContent = 'Retirar consentimento';
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
// === FIM NOVO ===

async function renderPerfilRecompensas() {
  const wrap = $('perfil-recompensas-wrap');
  const lista = $('perfil-recompensas-lista');
  const count = $('perfil-recompensas-count');

const { data, error } = await sb.rpc('get_recompensas', { p_pin: userNumber() });
   if (!error && data) setRecompensasVistas(data.length);

  if (error || !data || data.length === 0) {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  count.textContent = data.length;

  lista.innerHTML = data.map(r => {
    const dataStr = new Date(r.criado_em).toLocaleDateString('pt-PT');
    if (r.tipo === 'imagem' && r.imagem_url) {
      return `
        <li class="recompensa-item">
          <button type="button" class="recompensa-item__img-btn" data-lightbox data-img="${escapeHTML(r.imagem_url)}" data-titulo="${escapeHTML(r.titulo)}" data-desc="${escapeHTML(r.descricao || '')}" data-data="${escapeHTML(dataStr)}" aria-label="Ver recompensa ${escapeHTML(r.titulo)} em tamanho grande">
            <img src="${escapeHTML(r.imagem_url)}" alt="" class="recompensa-item__img">
          </button>
          <div class="recompensa-item__body">
            <div class="recompensa-item__titulo">${escapeHTML(r.titulo)}</div>
            ${r.descricao ? `<div class="recompensa-item__desc">${escapeHTML(r.descricao)}</div>` : ''}
            <div class="recompensa-item__data">Atribuída em ${dataStr}</div>
          </div>
        </li>
      `;
    }
   // sem imagem: voucher (🎟️) ou medalha (🏅, quando é tipo imagem mas sem ficheiro)
    const semImagemIcon = (r.tipo === 'voucher') ? '🎟️' : '🏅';
    return `
      <li class="recompensa-item">
        <div class="recompensa-item__icon">${semImagemIcon}</div>
        <div class="recompensa-item__body">
          <div class="recompensa-item__titulo">${escapeHTML(r.titulo)}</div>
          ${r.descricao ? `<div class="recompensa-item__desc">${escapeHTML(r.descricao)}</div>` : ''}
          ${r.voucher_codigo ? `<span class="recompensa-item__codigo">${escapeHTML(r.voucher_codigo)}</span>` : ''}
          <div class="recompensa-item__data">Atribuída em ${dataStr}</div>
        </div>
      </li>
    `;
  }).join('');
}

// ====== Lightbox de recompensa ======
(function initRecompensaLightbox() {
  const modal = document.getElementById('recompensa-modal');
  if (!modal) return;
  const imgEl   = document.getElementById('recompensa-modal-img');
  const titEl   = document.getElementById('recompensa-modal-titulo');
  const descEl  = document.getElementById('recompensa-modal-desc');
  const dataEl  = document.getElementById('recompensa-modal-data');
  const closeBtn = document.getElementById('recompensa-modal-close');
  let lastFocused = null;

  function abrir(d) {
    lastFocused = document.activeElement;
    imgEl.src = d.img || '';
    imgEl.alt = d.titulo ? `Recompensa: ${d.titulo}` : '';
    titEl.textContent = d.titulo || '';
    descEl.textContent = d.desc || '';
    descEl.hidden = !d.desc;
    dataEl.textContent = d.data ? `Atribuída em ${d.data}` : '';
    modal.hidden = false;
    closeBtn.focus();
  }
  function fechar() {
    modal.hidden = true;
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lightbox]');
    if (btn) {
      abrir({ img: btn.dataset.img, titulo: btn.dataset.titulo, desc: btn.dataset.desc, data: btn.dataset.data });
    }
  });
  closeBtn.addEventListener('click', fechar);
  modal.addEventListener('click', (e) => { if (e.target === modal) fechar(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) fechar();
  });
})();

function renderPerfilNotif() {
  const statusEl = $('perfil-notif-status');
  const btn = $('perfil-notif-btn');

  if (!Notifications.isSupported()) {
    statusEl.textContent = 'O seu browser não suporta notificações.';
    statusEl.className = 'perfil-notif__status perfil-notif__status--denied';
    btn.hidden = true;
    return;
  }

  const perm = Notifications.permissionStatus();
  const enabled = Notifications.isEnabled() && perm === 'granted';

  if (perm === 'denied') {
    statusEl.textContent = 'Permissão bloqueada. Ative nas definições do browser.';
    statusEl.className = 'perfil-notif__status perfil-notif__status--denied';
    btn.hidden = true;
    return;
  }

  if (enabled) {
    statusEl.textContent = 'Activas';
    statusEl.className = 'perfil-notif__status perfil-notif__status--on';
    btn.hidden = false;
    btn.textContent = 'Desativar';
    btn.className = 'perfil-notif__btn perfil-notif__btn--off';
  } else {
    statusEl.textContent = 'Desligadas';
    statusEl.className = 'perfil-notif__status perfil-notif__status--off';
    btn.hidden = false;
    btn.textContent = 'Ativar';
    btn.className = 'perfil-notif__btn';
  }
}

$('perfil-notif-btn').addEventListener('click', async () => {
  const enabled = Notifications.isEnabled() && Notifications.permissionStatus() === 'granted';
  if (enabled) {
    Notifications.disable();
  } else {
    const ok = await Notifications.enable();
    if (!ok && Notifications.permissionStatus() === 'denied') {
      alert('Permissão bloqueada. Para ativar, vá às definições do browser e permita notificações para esta app.');
    }
  }
  renderPerfilNotif();
});

$('perfil-back').addEventListener('click', () => goToDashboard());

$('perfil-logout').addEventListener('click', () => {
  if (confirm('Quer mesmo terminar sessão? Os seus medicamentos ficam guardados no telemóvel.')) {
    Notifications._clearTimers();
    // === NOVO: limpar chave de encriptação da memória ===
    window.QMSCrypto.lockSession();
    // === FIM NOVO ===
    clearSession();
    invalidateMedCaches();
    loginForm.reset();
    showView('login');
  }
});

// ============================================
// MEDICAMENTOS — armazenamento LOCAL no dispositivo
// (decisão de privacidade: dados de saúde não saem do equipamento)
// === NOVO: dados sensíveis encriptados via Web Crypto API (AES-GCM 256) ===
// ============================================

const DIAS_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Chaves localStorage (incluem número do utente para isolamento por sessão)
function storeKey(suffix) {
  const num = userNumber() || 'anon';
  return `mais_saude_${num}_${suffix}`;
}

// Store: API local com a mesma forma da que tínhamos com Supabase
const Store = {
  // ---------- TOMAS (modelo unificado: cada toma = data + hora concreta) ----------

  // === NOVO: leitura via secureGet (com fallback automático para plaintext legado) ===
  async _readAllTomas() {
    try {
      const data = await window.QMSCrypto.secureGet(storeKey('tomas'));
      if (Array.isArray(data)) return data;
      return [];
    } catch { return []; }
  },

  // === NOVO: escrita via secureSet (encripta antes de gravar) ===
  async _saveTomas(arr) {
    try {
      await window.QMSCrypto.secureSet(storeKey('tomas'), arr);
    } catch (e) { console.warn('Falha a guardar tomas local:', e); }
  },
  // === FIM NOVO ===

  async getTomas() {
    // Devolve todas, migrando se preciso
    await this._migrateIfNeeded();
    return await this._readAllTomas();
  },

  async getTomasByData(dataISO) {
    const all = await this.getTomas();
    return all.filter(t => t.data === dataISO)
      .sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));
  },

  async getTomasInRange(deISO, ateISO) {
    const all = await this.getTomas();
    return all.filter(t => t.data >= deISO && t.data <= ateISO)
      .sort((a, b) => {
        if (a.data !== b.data) return a.data.localeCompare(b.data);
        return (a.hora || '').localeCompare(b.hora || '');
      });
  },

  async getTomaById(id) {
    const all = await this._readAllTomas();
    return all.find(t => t.id === id) || null;
  },

  _newTomaId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  },

  async addToma(row) {
    const all = await this._readAllTomas();
    const nova = {
      id: this._newTomaId(),
      criado_em: new Date().toISOString(),
      tomado: null,
      hora_real: null,
      ...row,
    };
    all.push(nova);
    await this._saveTomas(all);
    return nova;
  },

  async addTomasInRange(template, deISO, ateISO) {
    // Cria uma toma por cada dia do intervalo (inclusive)
    const all = await this._readAllTomas();
    const ini = new Date(deISO);
    const fim = new Date(ateISO);
    if (fim < ini) throw new Error('Data final anterior à data inicial');
    const novas = [];
    let cursor = new Date(ini);
    while (cursor <= fim) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, '0');
      const d = String(cursor.getDate()).padStart(2, '0');
      novas.push({
        id: this._newTomaId() + '-' + novas.length,
        criado_em: new Date().toISOString(),
        tomado: null,
        hora_real: null,
        ...template,
        data: `${y}-${m}-${d}`,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    all.push(...novas);
    await this._saveTomas(all);
    return novas;
  },

  async updateToma(id, patch) {
    const all = await this._readAllTomas();
    const idx = all.findIndex(t => t.id === id);
    if (idx === -1) throw new Error('Toma não encontrada');
    all[idx] = { ...all[idx], ...patch };
    await this._saveTomas(all);
    return all[idx];
  },

  async deleteToma(id) {
    const all = await this._readAllTomas();
    const filtrado = all.filter(t => t.id !== id);
    await this._saveTomas(filtrado);
  },

  async marcarTomado(tomaId, tomado) {
    const all = await this._readAllTomas();
    const idx = all.findIndex(t => t.id === tomaId);
    if (idx === -1) return;
    all[idx].tomado = !!tomado;
    all[idx].hora_real = tomado ? new Date().toISOString() : null;
    await this._saveTomas(all);
  },

  // ---------- MIGRAÇÃO do modelo antigo (agendamentos+historico → tomas) ----------

  async _migrateIfNeeded() {
    const num = userNumber() || 'anon';
    const flagKey = `mais_saude_${num}_migrated_tomas`;
    if (localStorage.getItem(flagKey) === '1') return;
    if (localStorage.getItem(storeKey('tomas'))) {
      // Já existem tomas; marca migração como feita
      localStorage.setItem(flagKey, '1');
      return;
    }

    // Ler dados antigos (continuam em plaintext — formato legado)
    let antigos = [];
    let hist = [];
    try {
      const aRaw = localStorage.getItem(`mais_saude_${num}_agendamentos`);
      antigos = aRaw ? JSON.parse(aRaw) : [];
      const hRaw = localStorage.getItem(`mais_saude_${num}_historico`);
      hist = hRaw ? JSON.parse(hRaw) : [];
    } catch {}

    if (antigos.length === 0) {
      // Não há nada para migrar; marcar feita e seguir
      localStorage.setItem(flagKey, '1');
      return;
    }

    // Gerar tomas para [hoje - 30, hoje + 30]
    const novas = [];
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    for (let off = -30; off <= 30; off++) {
      const d = new Date(hoje); d.setDate(hoje.getDate() + off);
      const dow = d.getDay();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dataISO = `${y}-${m}-${day}`;

      for (const a of antigos) {
        if (a.ativo === false) continue;
        if (!Array.isArray(a.dias_semana) || !a.dias_semana.includes(dow)) continue;
        const histReg = hist.find(h => h.agendamento_id === a.id && h.data === dataISO);
        novas.push({
          id: this._newTomaId() + '-mig-' + novas.length,
          criado_em: a.criado_em || new Date().toISOString(),
          medicamento: a.medicamento,
          dose: a.dose || null,
          data: dataISO,
          hora: String(a.hora || '08:00').slice(0, 5),
          notas: a.notas || null,
          tomado: histReg ? (histReg.tomado || null) : null,
          hora_real: histReg && histReg.hora_real ? histReg.hora_real : null,
        });
      }
    }

    await this._saveTomas(novas);
    localStorage.setItem(flagKey, '1');
    // Remover dados antigos depois da migração
    try {
      localStorage.removeItem(`mais_saude_${num}_agendamentos`);
      localStorage.removeItem(`mais_saude_${num}_historico`);
    } catch {}
  },

  // ---------- Limpar tudo (usado no logout) ----------

  clearAll() {
    const num = userNumber() || 'anon';
    try {
      localStorage.removeItem(`mais_saude_${num}_tomas`);
      localStorage.removeItem(`mais_saude_${num}_medicoes`);
      localStorage.removeItem(`mais_saude_${num}_migrated_tomas`);
      // Apaga remanescentes do modelo antigo (caso existam)
      localStorage.removeItem(`mais_saude_${num}_agendamentos`);
      localStorage.removeItem(`mais_saude_${num}_historico`);
    } catch {}
  },

  // ---------- MEDIÇÕES (tensão arterial e glicemia) ----------

  // === NOVO: leitura via secureGet ===
  async _readAllMedicoes() {
    try {
      const data = await window.QMSCrypto.secureGet(storeKey('medicoes'));
      if (Array.isArray(data)) return data;
      return [];
    } catch { return []; }
  },

  // === NOVO: escrita via secureSet ===
  async _saveMedicoes(arr) {
    try {
      await window.QMSCrypto.secureSet(storeKey('medicoes'), arr);
    } catch (e) { console.warn('Falha a guardar medições local:', e); }
  },
  // === FIM NOVO ===

  async getMedicoes(tipo) {
    const all = await this._readAllMedicoes();
    const filtered = tipo ? all.filter(m => m.tipo === tipo) : all;
    return filtered.sort((a, b) => (b.data_hora || '').localeCompare(a.data_hora || ''));
  },

  async getMedicaoById(id) {
    const all = await this._readAllMedicoes();
    return all.find(m => m.id === id) || null;
  },

  async addMedicao(row) {
    const all = await this._readAllMedicoes();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const nova = { id, criado_em: new Date().toISOString(), ...row };
    all.push(nova);
    await this._saveMedicoes(all);
    return nova;
  },

  async updateMedicao(id, patch) {
    const all = await this._readAllMedicoes();
    const idx = all.findIndex(m => m.id === id);
    if (idx === -1) throw new Error('Medição não encontrada');
    all[idx] = { ...all[idx], ...patch };
    await this._saveMedicoes(all);
    return all[idx];
  },

  async deleteMedicao(id) {
    const all = await this._readAllMedicoes();
    const filtered = all.filter(m => m.id !== id);
    await this._saveMedicoes(filtered);
  },
};

// ============================================
// NOTIFICAÇÕES PWA (lembretes de medicação)
// ============================================

const Notifications = {
  _timers: [],
  KEY_ENABLED: 'mais_saude_notif_enabled',

  isSupported() {
    return 'Notification' in window;
  },

  isEnabled() {
    try { return localStorage.getItem(this.KEY_ENABLED) === '1'; }
    catch { return false; }
  },

  permissionStatus() {
    if (!this.isSupported()) return 'unsupported';
    return Notification.permission; // 'default' | 'granted' | 'denied'
  },

  async requestPermission() {
    if (!this.isSupported()) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      const result = await Notification.requestPermission();
      return result === 'granted';
    } catch { return false; }
  },

  async enable() {
    const granted = await this.requestPermission();
    if (!granted) return false;
    try { localStorage.setItem(this.KEY_ENABLED, '1'); } catch {}
    await this.reschedule();
    return true;
  },

  disable() {
    try { localStorage.removeItem(this.KEY_ENABLED); } catch {}
    this._clearTimers();
  },

  _clearTimers() {
    this._timers.forEach(id => clearTimeout(id));
    this._timers = [];
  },

  async reschedule() {
    this._clearTimers();
    if (!this.isEnabled()) return;
    if (!this.isSupported() || Notification.permission !== 'granted') return;

    const tomas = await Store.getTomasByData(todayISO());
    const now = Date.now();

    for (const t of tomas) {
      if (t.tomado === true) continue; // já tomado, sem lembrete

      const [h, m] = String(t.hora).split(':').map(Number);
      const target = new Date();
      target.setHours(h || 0, m || 0, 0, 0);
      const delay = target.getTime() - now;
      if (delay <= 0) continue; // já passou
      if (delay > 86400000) continue; // > 24h

      const tid = setTimeout(() => this._show(t), delay);
      this._timers.push(tid);
    }
  },

  async _show(t) {
    const title = 'Hora da medicação';
    const body = t.dose ? `${t.medicamento} · ${t.dose}` : t.medicamento;
    const options = {
      body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: `med-${t.id}`,
      requireInteraction: false,
      vibrate: [200, 100, 200],
    };
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        reg.showNotification(title, options);
      } else {
        new Notification(title, options);
      }
    } catch (e) {
      console.warn('Notificação falhou:', e);
    }
  },
};

// estado em memória (cache leve)
let _tomasCache = null;

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayDOW() { return new Date().getDay(); }
function nowMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function timeToMinutes(hhmm) { if (!hhmm) return 0; const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); }
function timeShort(hhmm) { if (!hhmm) return ''; return String(hhmm).slice(0, 5); }

async function fetchTomas(force = false) {
  if (!force && _tomasCache) return _tomasCache;
  _tomasCache = await Store.getTomas();
  return _tomasCache;
}

function invalidateMedCaches() {
  _tomasCache = null;
  Notifications.reschedule().catch(() => {});
}

// Estado de uma toma face à data/hora actual
function estadoToma(t, todayIso = todayISO(), nowMin = nowMinutes()) {
  if (t.data > todayIso) return 'futura';
  if (t.data < todayIso) return 'passada';
  // hoje
  return 'hoje';
}

// ---------- Card "Próxima toma" no Dashboard ----------

async function renderProximaToma() {
  const card = $('proxima-toma-card');
  const num = userNumber();
  if (!num) { card.hidden = true; return; }

  const tomas = await fetchTomas();
  const todayIso = todayISO();
  const nowMin = nowMinutes();

  // Total agendado (a partir de hoje)
  const totalFuturas = tomas.filter(t => t.data >= todayIso).length;
  $('dashboard-medicamentos-sub').textContent =
    totalFuturas === 0 ? 'Nenhuma toma agendada · adicione já'
    : totalFuturas === 1 ? '1 toma agendada'
    : `${totalFuturas} tomas agendadas`;

  // Próxima toma = a mais cedo entre:
  //  - hoje, hora ≥ agora, não marcada como tomada
  //  - futura
  const candidatas = tomas.filter(t => {
    if (t.data > todayIso) return true;
    if (t.data === todayIso) {
      if (t.tomado === true) return false;
      return timeToMinutes(t.hora) >= nowMin || t.tomado !== true;
    }
    return false;
  });

  if (candidatas.length === 0) {
    card.hidden = true;
    return;
  }

  candidatas.sort((a, b) => {
    if (a.data !== b.data) return a.data.localeCompare(b.data);
    return timeToMinutes(a.hora) - timeToMinutes(b.hora);
  });
  const proxima = candidatas[0];

  card.hidden = false;
  const prefixo = proxima.data === todayIso ? '' :
    (proxima.data === isoFromDate(new Date(Date.now() + 86400000)) ? 'Amanhã · ' :
    dateFromISO(proxima.data).toLocaleDateString('pt-PT') + ' · ');
  $('proxima-toma-hora').textContent = prefixo + timeShort(proxima.hora);
  $('proxima-toma-nome').textContent = proxima.dose
    ? `${proxima.medicamento} · ${proxima.dose}`
    : proxima.medicamento;

  const btn = $('proxima-toma-marcar');
  // Só permite marcar se for hoje (ou passado); futuras não
  if (proxima.data > todayIso) {
    btn.disabled = true;
    btn.textContent = 'Agendada';
  } else {
    btn.disabled = false;
    btn.textContent = 'Marcar como tomado';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'A guardar…';
      await Store.marcarTomado(proxima.id, true);
      invalidateMedCaches();
      announce('Toma marcada como tomada.');
      btn.disabled = false;
      btn.textContent = 'Marcar como tomado';
      await renderProximaToma();
    };
  }
}

// ============================================
// MEDICAMENTOS = CALENDÁRIO (vista única)
// ============================================

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

let _calMonth = new Date();    // 1º dia do mês a mostrar
let _calSelected = null;       // dataISO seleccionada (string YYYY-MM-DD)

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function pad2(n) { return String(n).padStart(2, '0'); }
function isoFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function dateFromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m-1, d);
}

async function goToMedicamentos() {
  // Por defeito mostra o mês actual com hoje seleccionado
  _calMonth = startOfMonth(new Date());
  _calSelected = todayISO();
  showView('medicamentos');
  await renderCalendario();
  await renderCalendarioDia();
}

$('medicamentos-back').addEventListener('click', () => goToDashboard());
$('medicamentos-add').addEventListener('click', () => {
  // Pré-preencher com o dia seleccionado no calendário
  goToTomaForm('new', null, _calSelected || todayISO());
});
$('cal-prev').addEventListener('click', async () => {
  _calMonth = new Date(_calMonth.getFullYear(), _calMonth.getMonth() - 1, 1);
  await renderCalendario();
});
$('cal-next').addEventListener('click', async () => {
  _calMonth = new Date(_calMonth.getFullYear(), _calMonth.getMonth() + 1, 1);
  await renderCalendario();
});

async function renderCalendario() {
  const year = _calMonth.getFullYear();
  const month = _calMonth.getMonth();
  $('cal-month-label').textContent = `${MESES[month]} ${year}`;

  const firstDay = new Date(year, month, 1);
  const firstWeekday = firstDay.getDay(); // 0=Dom
  const lastDay = new Date(year, month + 1, 0).getDate();
  const todayIso = todayISO();

  const tomas = await fetchTomas(true);

  // Agrupar tomas por data para lookup rápido
  const porData = {};
  for (const t of tomas) {
    (porData[t.data] = porData[t.data] || []).push(t);
  }

  let html = '';
  for (let i = 0; i < firstWeekday; i++) {
    html += `<button class="cal-cell cal-cell--empty" disabled aria-hidden="true"></button>`;
  }
  for (let day = 1; day <= lastDay; day++) {
    const dataISO = `${year}-${pad2(month+1)}-${pad2(day)}`;
    const isToday = dataISO === todayIso;
    const isSelected = dataISO === _calSelected;

    const tomasDia = porData[dataISO] || [];
    const hasDoses = tomasDia.length > 0;
    const allTaken = hasDoses && tomasDia.every(t => t.tomado === true);

    const classes = [
      'cal-cell',
      isToday && 'cal-cell--today',
      isSelected && 'cal-cell--selected',
      hasDoses && 'cal-cell--with-doses',
      allTaken && 'cal-cell--all-taken',
    ].filter(Boolean).join(' ');

    // Todos os dias são clicáveis agora (incluindo futuros — pode marcar/agendar tomas)
    html += `<button class="${classes}" data-date="${dataISO}">${day}</button>`;
  }

  $('cal-grid').innerHTML = html;

  $('cal-grid').querySelectorAll('.cal-cell:not(.cal-cell--empty)').forEach(btn => {
    btn.addEventListener('click', async () => {
      _calSelected = btn.dataset.date;
      await renderCalendario();
      await renderCalendarioDia();
    });
  });
}

async function renderCalendarioDia() {
  const titulo = $('cal-dia-titulo');
  const lista = $('cal-dia-tomas');

  if (!_calSelected) {
    titulo.textContent = 'Selecione um dia';
    lista.innerHTML = '';
    return;
  }

  const dataObj = dateFromISO(_calSelected);
  const diaSemana = ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'][dataObj.getDay()];
  titulo.textContent = `${dataObj.getDate()} de ${MESES[dataObj.getMonth()]} · ${diaSemana}`;

  const tomas = await Store.getTomasByData(_calSelected);
  const todayIso = todayISO();
  const isFuture = _calSelected > todayIso;

  if (tomas.length === 0) {
    const quando = (_calSelected === todayIso) ? 'para hoje' : 'para este dia';
    const hint = isFuture
      ? `Não há medicamentos agendados ${quando}. Toque em + para adicionar.`
      : `Não há medicamentos registados ${quando}. Toque em + para adicionar.`;
    lista.innerHTML = `<li class="hoje-empty">${hint}</li>`;
    return;
  }

  lista.innerHTML = tomas.map(t => {
    const tomado = t.tomado === true;
    const futura = t.data > todayIso;
    const dose = t.dose ? ` · ${escapeHTML(t.dose)}` : '';
    const tag = futura ? '<span class="tag-futura">Agendada</span>' : '';
    return `
      <li class="hoje-item ${tomado ? 'hoje-item--tomado' : ''} ${futura ? 'hoje-item--futura' : ''}" data-id="${escapeHTML(t.id)}" data-tomado="${tomado}" data-futura="${futura}" role="button" tabindex="0">
        <span class="hoje-check" aria-hidden="true"></span>
        <span class="hoje-item__hora">${timeShort(t.hora)}</span>
        <span class="hoje-item__info">
          <span class="hoje-item__nome">${escapeHTML(t.medicamento)}${tag}</span>
          ${dose ? `<span class="hoje-item__detalhe">${dose.replace(/^ · /, '')}</span>` : ''}
        </span>
        <button class="toma-edit" data-edit="${escapeHTML(t.id)}" aria-label="Editar" title="Editar">✎</button>
      </li>
    `;
  }).join('');

  // Click no item (toggle tomado, só se não for futura)
  lista.querySelectorAll('.hoje-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.toma-edit')) return; // botão de editar tem o seu próprio handler
      const futura = item.dataset.futura === 'true';
      if (futura) {
        // Não permite marcar tomas futuras
        return;
      }
      const id = item.dataset.id;
      const era = item.dataset.tomado === 'true';
      const novo = !era;
      item.classList.toggle('hoje-item--tomado', novo);
      item.dataset.tomado = novo;
      await Store.marcarTomado(id, novo);
      invalidateMedCaches();
      announce(novo ? 'Toma marcada como tomada.' : 'Toma desmarcada.');
      await renderCalendario();
    });
  });

  // Botão editar de cada toma
  lista.querySelectorAll('.toma-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      goToTomaForm('edit', btn.dataset.edit);
    });
  });
}

// ============================================
// Formulário de Toma (novo + editar)
// ============================================

let _editingTomaId = null;

function goToTomaForm(modo, id = null, dataPre = null) {
  _editingTomaId = (modo === 'edit') ? id : null;
  $('med-form-title').textContent = (modo === 'edit') ? 'Editar toma' : 'Nova toma';
  $('med-form-error').hidden = true;

  // Em modo edição não faz sentido o intervalo de datas — esconde data final
  const dataAteLabel = document.querySelector('label[for="med-form-data-ate"]') ||
    $('med-form-data-ate').closest('label');
  if (modo === 'edit') {
    if (dataAteLabel) dataAteLabel.style.display = 'none';
    $('med-form-delete').hidden = false;
  } else {
    if (dataAteLabel) dataAteLabel.style.display = '';
    $('med-form-delete').hidden = true;
  }

  if (modo === 'edit') {
    Store.getTomaById(id).then(t => { if (t) fillTomaForm(t); });
  } else {
    clearTomaForm(dataPre || todayISO());
  }

  showView('med-form');
}

function clearTomaForm(dataInicial) {
  $('med-form-id').value = '';
  $('med-form-nome').value = '';
  $('med-form-dose').value = '';
  $('med-form-hora').value = '08:00';
  $('med-form-data-de').value = dataInicial;
  $('med-form-data-ate').value = '';
  $('med-form-notas').value = '';
}

function fillTomaForm(t) {
  $('med-form-id').value = t.id;
  $('med-form-nome').value = t.medicamento || '';
  $('med-form-dose').value = t.dose || '';
  $('med-form-hora').value = timeShort(t.hora) || '08:00';
  $('med-form-data-de').value = t.data || todayISO();
  $('med-form-data-ate').value = ''; // não relevante em edição
  $('med-form-notas').value = t.notas || '';
}

$('med-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('med-form-error').hidden = true;

  const nome = $('med-form-nome').value.trim();
  const dose = $('med-form-dose').value.trim();
  const hora = $('med-form-hora').value;
  const dataDe = $('med-form-data-de').value;
  const dataAte = $('med-form-data-ate').value;
  const notas = $('med-form-notas').value.trim();

  if (!nome) { showMedFormError('Indique o nome do medicamento.'); return; }
  if (!hora) { showMedFormError('Indique a hora.'); return; }
  if (!dataDe) { showMedFormError('Indique a data inicial.'); return; }
  if (dataAte && dataAte < dataDe) {
    showMedFormError('A data final tem de ser igual ou posterior à data inicial.');
    return;
  }

  const template = {
    medicamento: nome,
    dose: dose || null,
    hora,
    notas: notas || null,
  };

  try {
    if (_editingTomaId) {
      // Edição: só altera esta toma (não cria série)
      await Store.updateToma(_editingTomaId, { ...template, data: dataDe });
    } else if (dataAte && dataAte > dataDe) {
      // Intervalo: cria uma toma por dia
      await Store.addTomasInRange(template, dataDe, dataAte);
    } else {
      // Só esse dia
      await Store.addToma({ ...template, data: dataDe });
    }
    invalidateMedCaches();
    goToMedicamentos();
  } catch (err) {
    showMedFormError('Erro ao guardar: ' + err.message);
  }
});

function showMedFormError(msg) {
  $('med-form-error').textContent = msg;
  $('med-form-error').hidden = false;
}

$('med-form-delete').addEventListener('click', async () => {
  if (!_editingTomaId) return;
  if (!confirm('Apagar esta toma? Esta acção não pode ser desfeita.')) return;
  try {
    await Store.deleteToma(_editingTomaId);
    invalidateMedCaches();
    goToMedicamentos();
  } catch (err) {
    showMedFormError('Erro ao apagar: ' + err.message);
  }
});

$('med-form-back').addEventListener('click', () => goToMedicamentos());

// ============================================
// MEDIÇÕES (tensão arterial e glicemia) — local, igual aos medicamentos
// ============================================

const CONTEXTO_LABELS = {
  'jejum': 'Em jejum',
  'antes-refeicao': 'Antes da refeição',
  'pos-refeicao': 'Depois da refeição',
  'antes-deitar': 'Antes de deitar',
  'outro': 'Outro',
};

let _currentMedicaoTipo = 'tensao';
let _editingMedicaoId = null;

// Formata data ISO para visualização curta
function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dia}/${mes} · ${hh}:${mm}`;
}

// Para o input datetime-local (formato YYYY-MM-DDTHH:MM, sem segundos)
function nowDatetimeLocal() {
  const d = new Date();
  const tzo = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tzo * 60000);
  return local.toISOString().slice(0, 16);
}
function isoFromDatetimeLocal(value) {
  // 'YYYY-MM-DDTHH:MM' -> 'YYYY-MM-DDTHH:MM:00.000Z' (em hora local interpretada como local)
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return d.toISOString();
}
function datetimeLocalFromISO(iso) {
  if (!iso) return nowDatetimeLocal();
  const d = new Date(iso);
  const tzo = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tzo * 60000);
  return local.toISOString().slice(0, 16);
}

// ---------- Página Medições ----------

async function goToMedicoes(tipo = 'tensao') {
  _currentMedicaoTipo = tipo;
  showView('medicoes');
  syncSegmented();
  await renderMedicoesContent();
}

function syncSegmented() {
  document.querySelectorAll('.segmented__btn').forEach(btn => {
    const active = btn.dataset.tipo === _currentMedicaoTipo;
    btn.classList.toggle('segmented__btn--active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

async function renderMedicoesContent() {
  const wrap = $('medicoes-content');
  wrap.innerHTML = '<p class="loading">A carregar…</p>';

  const tipo = _currentMedicaoTipo;
  const medicoes = await Store.getMedicoes(tipo);

  const ultima = medicoes[0] || null;
  const resto = medicoes.slice(1);

  let html = '';

  // Card "Última medição"
  if (ultima) {
    html += renderMedicaoUltimaCard(ultima, tipo);
  } else {
    html += `
      <div class="medicao-ultima medicao-ultima--vazia">
        <div>Ainda não há medições. Toque no <strong>+</strong> para adicionar a primeira.</div>
      </div>
    `;
  }

  // Histórico
  if (resto.length > 0) {
    html += `<h2 class="medicao-historico__title">Histórico</h2>`;
    html += `<ul class="medicao-lista">${resto.map(m => renderMedicaoItem(m, tipo)).join('')}</ul>`;
  } else if (ultima) {
    html += `<p class="medicoes-empty" style="margin-top:14px">Apenas uma medição registada por agora.</p>`;
  }

  wrap.innerHTML = html;

  // Ligar cliques nos items (abre form de edição)
  wrap.querySelectorAll('.medicao-item').forEach(item => {
    item.addEventListener('click', () => {
      goToMedicaoForm('edit', item.dataset.id, tipo);
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
    });
  });
}

function renderMedicaoUltimaCard(m, tipo) {
  if (tipo === 'tensao') {
    const pulso = m.pulso ? ` · pulso ${m.pulso} bpm` : '';
    return `
      <div class="medicao-ultima">
        <div class="medicao-ultima__label">Última medição</div>
        <div class="medicao-ultima__valor">${m.sistolica}/${m.diastolica}<small>mmHg</small></div>
        <div class="medicao-ultima__sub">${formatDateTime(m.data_hora)}${pulso}</div>
      </div>
    `;
  } else {
    const ctx = m.contexto ? ` · ${CONTEXTO_LABELS[m.contexto] || m.contexto}` : '';
    return `
      <div class="medicao-ultima">
        <div class="medicao-ultima__label">Última medição</div>
        <div class="medicao-ultima__valor">${m.valor}<small>mg/dL</small></div>
        <div class="medicao-ultima__sub">${formatDateTime(m.data_hora)}${ctx}</div>
      </div>
    `;
  }
}

function renderMedicaoItem(m, tipo) {
  if (tipo === 'tensao') {
    const pulso = m.pulso ? `pulso ${m.pulso}` : '';
    return `
      <li class="medicao-item" data-id="${escapeHTML(m.id)}" role="button" tabindex="0">
        <span class="medicao-item__valor">${m.sistolica}/${m.diastolica}</span>
        <span class="medicao-item__info">
          <span class="medicao-item__quando">${formatDateTime(m.data_hora)}</span>
          ${pulso ? `<span>${pulso} bpm</span>` : ''}
        </span>
      </li>
    `;
  } else {
    const ctx = m.contexto ? CONTEXTO_LABELS[m.contexto] || m.contexto : '';
    return `
      <li class="medicao-item" data-id="${escapeHTML(m.id)}" role="button" tabindex="0">
        <span class="medicao-item__valor">${m.valor}</span>
        <span class="medicao-item__info">
          <span class="medicao-item__quando">${formatDateTime(m.data_hora)}</span>
          ${ctx ? `<span class="medicao-item__contexto">${escapeHTML(ctx)}</span>` : ''}
        </span>
      </li>
    `;
  }
}

// Liga segmentos Tensão/Glicemia
document.querySelectorAll('.segmented__btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    _currentMedicaoTipo = btn.dataset.tipo;
    syncSegmented();
    await renderMedicoesContent();
  });
});

$('medicoes-back').addEventListener('click', () => goToDashboard());
$('medicoes-add').addEventListener('click', () => goToMedicaoForm('new', null, _currentMedicaoTipo));
$('dashboard-medicoes').addEventListener('click', () => goToMedicoes('tensao'));

// ---------- Formulário medição ----------

async function goToMedicaoForm(modo, id, tipo) {
  _editingMedicaoId = (modo === 'edit') ? id : null;
  const tipoFinal = tipo || _currentMedicaoTipo;

  // Mostrar/esconder grupos de campos conforme o tipo
  $('medicao-fields-tensao').hidden = (tipoFinal !== 'tensao');
  $('medicao-fields-glicemia').hidden = (tipoFinal !== 'glicemia');
  $('medicao-form-tipo').value = tipoFinal;

  $('medicao-form-error').hidden = true;

  if (modo === 'edit') {
    const m = await Store.getMedicaoById(id);
    if (m) fillMedicaoForm(m);
    $('medicao-form-delete').hidden = false;
    $('medicao-form-title').textContent = (tipoFinal === 'tensao') ? 'Editar tensão arterial' : 'Editar glicémia';
  } else {
    clearMedicaoForm();
    $('medicao-form-delete').hidden = true;
    $('medicao-form-title').textContent = (tipoFinal === 'tensao') ? 'Nova medição de tensão arterial' : 'Nova medição de glicémia';
  }

  showView('medicao-form');
}

function clearMedicaoForm() {
  $('medicao-form-id').value = '';
  $('medicao-form-sistolica').value = '';
  $('medicao-form-diastolica').value = '';
  $('medicao-form-pulso').value = '';
  $('medicao-form-valor').value = '';
  $('medicao-form-contexto').value = '';
  $('medicao-form-datahora').value = nowDatetimeLocal();
  $('medicao-form-notas').value = '';
}

function fillMedicaoForm(m) {
  $('medicao-form-id').value = m.id;
  if (m.tipo === 'tensao') {
    $('medicao-form-sistolica').value = m.sistolica || '';
    $('medicao-form-diastolica').value = m.diastolica || '';
    $('medicao-form-pulso').value = m.pulso || '';
  } else {
    $('medicao-form-valor').value = m.valor || '';
    $('medicao-form-contexto').value = m.contexto || '';
  }
  $('medicao-form-datahora').value = datetimeLocalFromISO(m.data_hora);
  $('medicao-form-notas').value = m.notas || '';
}

$('medicao-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('medicao-form-error').hidden = true;

  const tipo = $('medicao-form-tipo').value;
  const dataHoraISO = isoFromDatetimeLocal($('medicao-form-datahora').value);
  const notas = $('medicao-form-notas').value.trim();

  const row = {
    tipo,
    data_hora: dataHoraISO,
    notas: notas || null,
  };

  if (tipo === 'tensao') {
    const sis = parseInt($('medicao-form-sistolica').value, 10);
    const dia = parseInt($('medicao-form-diastolica').value, 10);
    const pulso = $('medicao-form-pulso').value;
    if (!sis || !dia) {
      showMedicaoFormError('Indique a sistólica e a diastólica.');
      return;
    }
    if (sis <= dia) {
      showMedicaoFormError('A sistólica (máxima) tem de ser maior que a diastólica (mínima).');
      return;
    }
    row.sistolica = sis;
    row.diastolica = dia;
    row.pulso = pulso ? parseInt(pulso, 10) : null;
  } else if (tipo === 'glicemia') {
    const valor = parseInt($('medicao-form-valor').value, 10);
    if (!valor) {
      showMedicaoFormError('Indique o valor da glicémia.');
      return;
    }
    row.valor = valor;
    row.contexto = $('medicao-form-contexto').value || null;
  }

  try {
    if (_editingMedicaoId) {
      await Store.updateMedicao(_editingMedicaoId, row);
    } else {
      await Store.addMedicao(row);
    }
    goToMedicoes(tipo);
  } catch (err) {
    showMedicaoFormError('Erro ao guardar: ' + err.message);
  }
});

function showMedicaoFormError(msg) {
  $('medicao-form-error').textContent = msg;
  $('medicao-form-error').hidden = false;
}

$('medicao-form-delete').addEventListener('click', async () => {
  if (!_editingMedicaoId) return;
  if (!confirm('Apagar esta medição?')) return;
  try {
    await Store.deleteMedicao(_editingMedicaoId);
    goToMedicoes(_currentMedicaoTipo);
  } catch (err) {
    showMedicaoFormError('Erro ao apagar: ' + err.message);
  }
});

$('medicao-form-back').addEventListener('click', () => goToMedicoes(_currentMedicaoTipo));

// ============================================
// EXPORTAR — CSV e PDF (via window.print() para PDF)
// ============================================

function goToExportar() {
  // Defaults: últimos 30 dias até hoje
  const hoje = new Date();
  const ate = isoFromDate(hoje);
  hoje.setDate(hoje.getDate() - 30);
  const de = isoFromDate(hoje);
  $('exportar-de').value = de;
  $('exportar-ate').value = ate;
  showView('exportar');
}
$('perfil-exportar').addEventListener('click', goToExportar);
$('exportar-back').addEventListener('click', () => goToPerfil());

// Chips de período rápido
document.querySelectorAll('.chip[data-preset]').forEach(chip => {
  chip.addEventListener('click', () => {
    const preset = chip.dataset.preset;
    const hoje = new Date();
    $('exportar-ate').value = isoFromDate(hoje);
    if (preset === 'all') {
      $('exportar-de').value = '2000-01-01';
    } else {
      const inicio = new Date(hoje);
      inicio.setDate(hoje.getDate() - parseInt(preset, 10));
      $('exportar-de').value = isoFromDate(inicio);
    }
  });
});

function periodoSeleccionado() {
  const de = $('exportar-de').value || '2000-01-01';
  const ate = $('exportar-ate').value || isoFromDate(new Date());
  // Garantir ordem
  return de <= ate ? { de, ate } : { de: ate, ate: de };
}

// Liga botões CSV / PDF aos handlers
document.querySelectorAll('[data-export]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const tipo = btn.dataset.export;
    const formato = btn.dataset.format;
    btn.disabled = true;
    btn.textContent = 'A preparar…';
    try {
      if (formato === 'csv') await exportarCSV(tipo);
      else if (formato === 'pdf') await exportarPDF(tipo);
    } catch (err) {
      alert('Erro a exportar: ' + (err.message || err));
    } finally {
      btn.disabled = false;
      btn.textContent = formato.toUpperCase();
    }
  });
});

// ---------- Geração de dados (filtrados por período) ----------

function dentroPeriodo(dataISO, periodo) {
  return dataISO >= periodo.de && dataISO <= periodo.ate;
}

async function dadosTensao(periodo) {
  const lista = await Store.getMedicoes('tensao');
  return lista
    .filter(m => {
      if (!m.data_hora) return false;
      const d = isoFromDate(new Date(m.data_hora));
      return dentroPeriodo(d, periodo);
    })
    .map(m => ({
      data: new Date(m.data_hora).toLocaleDateString('pt-PT'),
      hora: new Date(m.data_hora).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }),
      sistolica: m.sistolica,
      diastolica: m.diastolica,
      pulso: m.pulso || '',
      notas: m.notas || '',
    }));
}

async function dadosGlicemia(periodo) {
  const lista = await Store.getMedicoes('glicemia');
  return lista
    .filter(m => {
      if (!m.data_hora) return false;
      const d = isoFromDate(new Date(m.data_hora));
      return dentroPeriodo(d, periodo);
    })
    .map(m => ({
      data: new Date(m.data_hora).toLocaleDateString('pt-PT'),
      hora: new Date(m.data_hora).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }),
      valor: m.valor,
      contexto: m.contexto ? (CONTEXTO_LABELS[m.contexto] || m.contexto) : '',
      notas: m.notas || '',
    }));
}

// Adesão à medicação: lista as tomas que existem no período (não as "esperadas
// por padrão semanal" — só o que efectivamente foi agendado)
async function dadosAdesao(periodo) {
  const tomas = await Store.getTomasInRange(periodo.de, periodo.ate);
  const todayIso = todayISO();
  const linhas = tomas.map(t => {
    let estado;
    if (t.data > todayIso) estado = 'Agendada';
    else if (t.tomado === true) estado = 'Tomada';
    else if (t.tomado === false) estado = 'Não tomada';
    else estado = (t.data === todayIso ? 'Por marcar' : 'Não marcada');

    const horaReal = (t.tomado === true && t.hora_real)
      ? new Date(t.hora_real).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
      : '';

    return {
      data: dateFromISO(t.data).toLocaleDateString('pt-PT'),
      dataISO: t.data,
      hora_prevista: timeShort(t.hora),
      medicamento: t.medicamento,
      dose: t.dose || '',
      estado,
      tomado: t.tomado === true,
      hora_real: horaReal,
    };
  });

  // Ordenar por data desc, dentro do dia por hora asc
  linhas.sort((a, b) => {
    if (a.dataISO !== b.dataISO) return b.dataISO.localeCompare(a.dataISO);
    return (a.hora_prevista || '').localeCompare(b.hora_prevista || '');
  });

  return linhas;
}

// ---------- CSV ----------

function escapeCSV(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function rowsToCSV(headers, rows) {
  const linhas = [headers.map(escapeCSV).join(',')];
  for (const r of rows) linhas.push(r.map(escapeCSV).join(','));
  // BOM UTF-8 para o Excel abrir bem com acentos
  return '\ufeff' + linhas.join('\r\n');
}

function triggerDownload(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportarCSV(tipo) {
  const num = userNumber() || 'utente';
  const periodo = periodoSeleccionado();
  const dataStr = new Date().toISOString().slice(0, 10);
  let headers, rows, filename;

  if (tipo === 'tensao') {
    const dados = await dadosTensao(periodo);
    headers = ['Data', 'Hora', 'Sistolica (mmHg)', 'Diastolica (mmHg)', 'Pulso (bpm)', 'Notas'];
    rows = dados.map(d => [d.data, d.hora, d.sistolica, d.diastolica, d.pulso, d.notas]);
    filename = `tensao-${num}-${dataStr}.csv`;
  } else if (tipo === 'glicemia') {
    const dados = await dadosGlicemia(periodo);
    headers = ['Data', 'Hora', 'Valor (mg/dL)', 'Contexto', 'Notas'];
    rows = dados.map(d => [d.data, d.hora, d.valor, d.contexto, d.notas]);
    filename = `glicemia-${num}-${dataStr}.csv`;
  } else if (tipo === 'medicacao') {
    const dados = await dadosAdesao(periodo);
    headers = ['Data', 'Hora prevista', 'Medicamento', 'Dose', 'Estado', 'Hora real'];
    rows = dados.map(d => [d.data, d.hora_prevista, d.medicamento, d.dose, d.estado, d.hora_real]);
    filename = `adesao-${num}-${dataStr}.csv`;
  } else {
    throw new Error('Tipo desconhecido: ' + tipo);
  }

  const csv = rowsToCSV(headers, rows);
  triggerDownload(csv, filename, 'text/csv;charset=utf-8');
}

// ---------- PDF (via vista de relatório + window.print()) ----------

async function exportarPDF(tipo) {
  // Vai para vista de relatório com os dados certos
  await renderRelatorio(tipo);
  showView('relatorio');
}

async function renderRelatorio(tipo) {
  const num = userNumber() || '—';
  const periodo = periodoSeleccionado();
  $('relatorio-numero').textContent = num;
  const deLabel = dateFromISO(periodo.de).toLocaleDateString('pt-PT');
  const ateLabel = dateFromISO(periodo.ate).toLocaleDateString('pt-PT');
  $('relatorio-data').textContent = `${new Date().toLocaleString('pt-PT')} · Período: ${deLabel} a ${ateLabel}`;

  let titulo, html;
  if (tipo === 'tensao') {
    titulo = 'Tensão arterial';
    const dados = await dadosTensao(periodo);
    html = dados.length === 0
      ? '<div class="relatorio-empty">Sem medições de tensão no período selecionado.</div>'
      : `<table class="relatorio-table">
          <thead><tr>
            <th>Data</th><th>Hora</th><th>Sist.</th><th>Diast.</th><th>Pulso</th><th>Notas</th>
          </tr></thead>
          <tbody>${dados.map(d => `
            <tr>
              <td>${escapeHTML(d.data)}</td>
              <td>${escapeHTML(d.hora)}</td>
              <td>${d.sistolica} mmHg</td>
              <td>${d.diastolica} mmHg</td>
              <td>${d.pulso ? d.pulso + ' bpm' : '—'}</td>
              <td>${escapeHTML(d.notas)}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
  } else if (tipo === 'glicemia') {
    titulo = 'Glicémia';
    const dados = await dadosGlicemia(periodo);
    html = dados.length === 0
      ? '<div class="relatorio-empty">Sem medições de glicémia no período selecionado.</div>'
      : `<table class="relatorio-table">
          <thead><tr>
            <th>Data</th><th>Hora</th><th>Valor</th><th>Contexto</th><th>Notas</th>
          </tr></thead>
          <tbody>${dados.map(d => `
            <tr>
              <td>${escapeHTML(d.data)}</td>
              <td>${escapeHTML(d.hora)}</td>
              <td>${d.valor} mg/dL</td>
              <td>${escapeHTML(d.contexto)}</td>
              <td>${escapeHTML(d.notas)}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
  } else if (tipo === 'medicacao') {
    titulo = 'Adesão à terapêutica';
    const dados = await dadosAdesao(periodo);
    if (dados.length === 0) {
      html = '<div class="relatorio-empty">Sem tomas registadas no período. Adicione tomas no calendário primeiro.</div>';
    } else {
      // Taxa de adesão considera apenas tomas que já passaram (passadas + hoje)
      const consideradas = dados.filter(d => d.estado !== 'Agendada');
      const total = consideradas.length;
      const tomados = consideradas.filter(d => d.estado === 'Tomada').length;
      const agendadas = dados.length - total;
      const taxa = total > 0 ? Math.round((tomados / total) * 100) : 0;
      const resumoBase = total > 0
        ? `<strong>Adesão:</strong> ${tomados} de ${total} tomas marcadas como tomadas (${taxa}%)`
        : `<strong>Sem tomas passadas no período.</strong>`;
      const resumoAg = agendadas > 0 ? ` · ${agendadas} tomas futuras agendadas.` : '';
      const resumo = `<p style="margin:6px 0 14px;font-size:13px;color:var(--ink)">${resumoBase}${resumoAg}</p>`;
      const tagFor = (estado) => {
        if (estado === 'Tomada') return '<span class="tag tag--ok">Tomada</span>';
        if (estado === 'Não tomada') return '<span class="tag tag--miss">Não tomada</span>';
        if (estado === 'Agendada') return '<span class="tag tag--future">Agendada</span>';
        return '<span class="tag tag--miss">' + escapeHTML(estado) + '</span>';
      };
      html = resumo + `<table class="relatorio-table">
        <thead><tr>
          <th>Data</th><th>Hora</th><th>Medicamento</th><th>Dose</th><th>Estado</th><th>Hora real</th>
        </tr></thead>
        <tbody>${dados.map(d => `
          <tr>
            <td>${escapeHTML(d.data)}</td>
            <td>${escapeHTML(d.hora_prevista)}</td>
            <td>${escapeHTML(d.medicamento)}</td>
            <td>${escapeHTML(d.dose)}</td>
            <td>${tagFor(d.estado)}</td>
            <td>${escapeHTML(d.hora_real)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    }
  } else {
    titulo = 'Relatório';
    html = '<div class="relatorio-empty">Tipo desconhecido.</div>';
  }

  $('relatorio-tipo').textContent = titulo;
  $('relatorio-conteudo').innerHTML = html;
}

$('relatorio-back').addEventListener('click', () => goToExportar());
$('relatorio-print').addEventListener('click', () => window.print());
$('relatorio-print-cta').addEventListener('click', () => window.print());

// ============================================
// ACESSIBILIDADE — preferências do utilizador (texto maior, alto contraste, anim. reduzidas)
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
  save(prefs) {
    try { localStorage.setItem(A11Y_KEY, JSON.stringify(prefs)); } catch {}
  },
  apply(prefs) {
    document.body.classList.toggle('a11y-large-text', !!prefs.largeText);
    document.body.classList.toggle('a11y-high-contrast', !!prefs.highContrast);
    document.body.classList.toggle('a11y-reduced-motion', !!prefs.reducedMotion);
    // Botão "Ouvir" só aparece quando readAloud está ON
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
    // Liga os toggles do menu Acessibilidade (quando existirem)
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

// Aplicar imediatamente as preferências antes de qualquer render visual
A11y.apply(A11y.load());
// Ligar toggles depois do DOM estar pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => A11y.init());
} else {
  A11y.init();
}

// Anunciar mensagens dinâmicas para leitores de ecrã
function announce(msg) {
  const el = document.getElementById('a11y-announcer');
  if (!el) return;
  el.textContent = '';
  // Pequeno timeout faz o screen reader detectar como nova mensagem
  setTimeout(() => { el.textContent = msg; }, 50);
}

// ============================================
// LEITURA EM VOZ ALTA — Web Speech API
// ============================================

const TTS = {
  speaking: false,
  _utterance: null,

  isSupported() {
    return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  },

  toggle() {
    if (this.speaking) this.stop();
    else this.start();
  },

  start() {
    if (!this.isSupported()) {
      announce('Síntese de voz não suportada neste browser.');
      return;
    }
    const view = document.querySelector('.view:not([hidden])');
    if (!view) return;
    const text = this._extractText(view);
    if (!text.trim()) {
      announce('Nada para ler nesta página.');
      return;
    }

    window.speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-PT';
    u.rate = 1.0;
    u.pitch = 1.0;
    u.onend = () => { this.speaking = false; this._updateButton(); };
    u.onerror = () => { this.speaking = false; this._updateButton(); };
    u.onstart = () => { this.speaking = true; this._updateButton(); };

    this._utterance = u;
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
        // Saltar elementos escondidos, sr-only e aria-hidden
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
    while ((n = walker.nextNode())) {
      parts.push(n.textContent.trim());
    }
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

// Ligar o botão (depois do DOM estar pronto)
function bindTTS() {
  const btn = document.getElementById('tts-btn');
  if (!btn) return;
  btn.addEventListener('click', () => TTS.toggle());

  // Parar a leitura sempre que mudamos de view (a visibilidade muda via [hidden])
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName === 'hidden') {
        TTS.stop();
        break;
      }
    }
  });
  document.querySelectorAll('.view').forEach(v => {
    obs.observe(v, { attributes: true, attributeFilter: ['hidden'] });
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindTTS);
} else {
  bindTTS();
}

// ============================================
// INSTALAR A APP — PWA install prompt
// ============================================

let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  // Browser está pronto a oferecer instalação
  e.preventDefault();
  _deferredInstallPrompt = e;
  const card = document.getElementById('install-card');
  if (card) card.hidden = false;
});

// Detectar iOS para mostrar instruções alternativas
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function isInStandaloneMode() {
  return ('standalone' in window.navigator && window.navigator.standalone) ||
         window.matchMedia('(display-mode: standalone)').matches;
}

// Quando entras no Perfil, mostrar o install card se aplicável
function refreshInstallCard() {
  const card = document.getElementById('install-card');
  if (!card) return;
  if (isInStandaloneMode()) {
    // Já está instalada — esconde
    card.hidden = true;
    return;
  }
  // Mostrar sempre (a lógica do botão trata de cada caso)
  card.hidden = false;
}

const installBtn = document.getElementById('install-btn');
if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (_deferredInstallPrompt) {
      // Browser pronto a oferecer instalação nativa
      _deferredInstallPrompt.prompt();
      const { outcome } = await _deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        announce('App instalada com sucesso.');
        document.getElementById('install-card').hidden = true;
      }
      _deferredInstallPrompt = null;
      return;
    }
    if (isIOS()) {
      // iOS Safari → instruções específicas
      const modal = document.getElementById('ios-install-modal');
      modal.hidden = false;
      const closeBtn = document.getElementById('ios-install-close');
      if (closeBtn) closeBtn.focus();
      return;
    }
    // Outros browsers → instruções genéricas
    const generic = document.getElementById('generic-install-modal');
    if (generic) {
      generic.hidden = false;
      const closeBtn = document.getElementById('generic-install-close');
      if (closeBtn) closeBtn.focus();
    }
  });
}

const iosClose = document.getElementById('ios-install-close');
if (iosClose) {
  iosClose.addEventListener('click', () => {
    document.getElementById('ios-install-modal').hidden = true;
  });
}
const genericClose = document.getElementById('generic-install-close');
if (genericClose) {
  genericClose.addEventListener('click', () => {
    document.getElementById('generic-install-modal').hidden = true;
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    ['ios-install-modal', 'generic-install-modal'].forEach(id => {
      const m = document.getElementById(id);
      if (m && !m.hidden) m.hidden = true;
    });
  }
});

// Quando app é instalada, esconder o card
window.addEventListener('appinstalled', () => {
  const card = document.getElementById('install-card');
  if (card) card.hidden = true;
  announce('App instalada no seu dispositivo.');
});

// ============================================
// Indicador de online/offline
// ============================================

function updateOnlineStatus() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  if (navigator.onLine) {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    announce('Sem ligação à internet.');
  }
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateOnlineStatus);
} else {
  updateOnlineStatus();
}

// ============================================
// Service Worker
// ============================================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ============================================
// ARRANQUE — splash → welcome / login / dashboard
// === NOVO: restaurar chave de encriptação + verificar consentimento
// ============================================

(async function init() {
  // Splash dura ~2.2s (animação CSS já gere o fade-out)
  await sleep(2200);

  if (loadSession()) {
    // === NOVO: tentar re-derivar a chave de encriptação a partir
    //          do PIN + ano guardados na sessão. Se faltar o ano
    //          (sessão antiga, pré-encriptação), forçar re-login.
    const pin = userNumber();
    const ano = state.user?.ano_nascimento;

    if (!pin || !ano) {
      // Sessão sem ano de nascimento — formato antigo, força re-login
      clearSession();
      showView(hasWelcomed() ? 'login' : 'welcome');
    } else {
      try {
        await window.QMSCrypto.deriveSessionKey(pin, ano);

        // Verificar consentimento — pode ter sido revogado ou versão actualizada
        try {
          const consent = await window.QMSConsent.getConsentStatus(pin, sb);
          const currentVersion = window.QMSConsent.CONSENT_VERSION;
          if (!consent || consent.consent_version !== currentVersion) {
            const newConsent = await window.QMSConsent.ensureConsent(pin, sb);
            if (!newConsent) {
              // Utilizador recusou consentimento → sair
              window.QMSCrypto.lockSession();
              clearSession();
              showView('login');
              return;
            }
          }
        } catch (consentErr) {
          console.warn('Verificação de consentimento falhou (a continuar):', consentErr);
          // Se a verificação falhar (ex: offline), permite continuar — a
          // próxima sincronização tentará de novo
        }

        await goToDashboard();
      } catch (err) {
        console.error('Falha a restaurar sessão:', err);
        window.QMSCrypto.lockSession();
        clearSession();
        showView('login');
      }
    }
    // === FIM NOVO ===
  } else if (hasWelcomed()) {
    showView('login');
  } else {
    showView('welcome');
  }

  // Restaurar agendamento de notificações se o utente as activou anteriormente
  if (Notifications.isEnabled() && Notifications.permissionStatus() === 'granted') {
    Notifications.reschedule().catch(() => {});
  }
})();
