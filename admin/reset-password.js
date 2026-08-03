// ============================================================
// admin/reset-password.js
// Recebe o utilizador via link de email do Supabase
// Valida o token, permite definir password nova
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// === CONFIG — credenciais do projecto Sara ===
const SUPABASE_URL = 'https://hhozgecuyczrbvyzvaoz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhob3pnZWN1eWN6cmJ2eXp2YW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY4MjA1NjUsImV4cCI6MjA2MjM5NjU2NX0.26C81920FzVHVCp6OFqCUhoo6NfDnVnTZhskVNuR5qo';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// === DOM ===
const loadingSection = document.getElementById('loading-section');
const invalidSection = document.getElementById('invalid-section');
const formSection = document.getElementById('form-section');
const successSection = document.getElementById('success-section');
const form = document.getElementById('form-reset');
const btn = document.getElementById('btn-reset');
const errBox = document.getElementById('auth-error');

// === Helpers ===
function showError(msg) {
  errBox.textContent = msg;
  errBox.hidden = !msg;
}

function showSection(section) {
  loadingSection.hidden = true;
  invalidSection.hidden = true;
  formSection.hidden = true;
  successSection.hidden = true;
  section.hidden = false;
}

function setLoading(isLoading) {
  btn.disabled = isLoading;
  btn.textContent = isLoading ? 'A guardar…' : 'Definir password e entrar';
}

// ============================================================
// INIT — Detecta tokens no URL fragment ou query string
// ============================================================
//
// O Supabase, ao redireccionar o utilizador a partir do email,
// pode usar dois formatos:
//
// 1. HASH FRAGMENT (default em alguns templates):
//    https://.../reset-password.html#access_token=xxx&refresh_token=yyy&type=recovery
//
// 2. QUERY STRING com code (PKCE flow, default em templates novos):
//    https://.../reset-password.html?code=xxx
//
// Tratamos ambos.
// ============================================================
async function init() {
  try {
    const hash = window.location.hash;
    const search = window.location.search;

    let validRecoveryLink = false;

    // FORMATO 1 — hash fragment com access_token
    if (hash && hash.includes('access_token')) {
      const params = new URLSearchParams(hash.substring(1));
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const type = params.get('type');

      if (accessToken && refreshToken && type === 'recovery') {
        const { data, error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });

        if (!error && data.session) {
          validRecoveryLink = true;
        } else {
          console.error('setSession error:', error);
        }
      }
    }

    // FORMATO 2 — query string com code (PKCE flow)
    if (!validRecoveryLink && search && search.includes('code=')) {
      const params = new URLSearchParams(search);
      const code = params.get('code');

      if (code) {
        const { data, error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error && data.session) {
          validRecoveryLink = true;
        } else {
          console.error('exchangeCodeForSession error:', error);
        }
      }
    }

    // FORMATO 3 — Já temos sessão activa (utilizador logado)
    if (!validRecoveryLink) {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        validRecoveryLink = true;
      }
    }

    if (!validRecoveryLink) {
      showSection(invalidSection);
      return;
    }

    // Limpa o URL para não deixar tokens visíveis
    window.history.replaceState({}, document.title, window.location.pathname);

    // Mostra o formulário de password
    showSection(formSection);
    document.getElementById('new-password').focus();

  } catch (err) {
    console.error('Init error:', err);
    showSection(invalidSection);
  }
}

// ============================================================
// FORM SUBMIT — Define a nova password
// ============================================================
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');

  const newPassword = document.getElementById('new-password').value;
  const confirmPassword = document.getElementById('confirm-password').value;

  // Validações locais
  if (newPassword.length < 12) {
    showError('A password deve ter pelo menos 12 caracteres.');
    return;
  }

  if (newPassword !== confirmPassword) {
    showError('As passwords não coincidem.');
    return;
  }

  // Validação de força mínima
  const hasLetter = /[a-zA-Z]/.test(newPassword);
  const hasNumber = /[0-9]/.test(newPassword);
  if (!hasLetter || !hasNumber) {
    showError('A password deve conter pelo menos uma letra e um número.');
    return;
  }

  setLoading(true);

  try {
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      showError('Erro ao guardar password: ' + error.message);
      setLoading(false);
      return;
    }

    // Sucesso — mostra mensagem e redirecciona para o painel
    showSection(successSection);

    setTimeout(() => {
      // Redirecciona para o painel actual (index.html, single-page com login + dashboard)
      window.location.replace('index.html');
    }, 2000);

  } catch (err) {
    console.error(err);
    showError('Erro inesperado. Tente de novo.');
    setLoading(false);
  }
});

// === Arranque ===
init();
