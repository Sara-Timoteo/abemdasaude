// ============================================================
// admin/forgot-password.js — Pede email de recovery
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// === CONFIG — credenciais do projecto Sara ===
const SUPABASE_URL = 'https://hhozgecuyczrbvyzvaoz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhob3pnZWN1eWN6cmJ2eXp2YW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY4MjA1NjUsImV4cCI6MjA2MjM5NjU2NX0.26C81920FzVHVCp6OFqCUhoo6NfDnVnTZhskVNuR5qo';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// === DOM ===
const formSection = document.getElementById('form-section');
const successSection = document.getElementById('success-section');
const form = document.getElementById('form-forgot');
const btn = document.getElementById('btn-send');
const errBox = document.getElementById('auth-error');
const sentEmailSpan = document.getElementById('sent-email');

// === Helpers ===
function showError(msg) {
  errBox.textContent = msg;
  errBox.hidden = !msg;
}

function setLoading(isLoading) {
  btn.disabled = isLoading;
  btn.textContent = isLoading ? 'A enviar…' : 'Enviar email de recuperação';
}

// === Submit handler ===
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  setLoading(true);

  const email = document.getElementById('forgot-email').value.trim();

  try {
    // Construir o URL absoluto para redirect após o utilizador clicar
    // no link do email. Usa o mesmo origin/path da página actual.
    const baseUrl = window.location.href
      .replace(/\/forgot-password\.html.*$/, '')
      .replace(/\/$/, '');
    const redirectUrl = `${baseUrl}/reset-password.html`;

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectUrl,
    });

    if (error) {
      // Não revelamos se o email existe ou não (anti-enumeração)
      // Mas mostramos erros técnicos genuínos (rate limit, etc.)
      if (error.message.toLowerCase().includes('rate limit')) {
        showError('Demasiados pedidos. Aguarde alguns minutos e tente de novo.');
        setLoading(false);
        return;
      } else {
        console.error('Reset password error:', error);
        // Continua para o success state — não revelar se email existe
      }
    }

    // Sempre mostra o success state (não revelar se email existe)
    sentEmailSpan.textContent = email;
    formSection.hidden = true;
    successSection.hidden = false;

  } catch (err) {
    console.error(err);
    showError('Erro inesperado. Tente de novo.');
  } finally {
    setLoading(false);
  }
});
