/* ============================================================
   Quiz Mais Saúde — Consent flow.
   
   Funções:
     QMSConsent.ensureConsent(pin, sb)  → record (ou null se recusou)
     QMSConsent.getConsentStatus(pin, sb) → record actual ou null
     QMSConsent.withdrawConsent(pin, sb) → apaga dados servidor
     QMSConsent.CONSENT_VERSION → string
   
   Subir a versão quando o texto mudar — utilizadores serão re-prompted.
   ============================================================ */

(function () {
  'use strict';

  const CONSENT_VERSION = 'v3-2026-07';

  const TEXT = {
    version: CONSENT_VERSION,
    title: 'Antes de continuar',
    intro: '    intro: 'A sua privacidade é importante. Antes de usar a app abem: da Saúde, leia como tratamos os seus dados. Ao tocar em «Aceitar e continuar», concorda com este tratamento.',',
    reassurance: 'Os dados sobre os seus medicamentos e medições (tensão, glicémia) ficam apenas no seu telemóvel, encriptados.',
    changeMind: 'Pode mudar de ideias a qualquer momento, no seu perfil.',
    buttonAccept: 'Aceitar e continuar',
    buttonRefuse: 'Não aceito',
    policyHtml: `
      <h3>Privacidade e Proteção de Dados</h3>
      <p>A presente aplicação é disponibilizada pela Associação Dignitude, com NIPC 513696628.</p>
      <p>Ao utilizar a presente aplicação, serão utilizados dados pessoais para as seguintes finalidades:</p>
      <ul>
        <li><strong>Gestão de Acessos</strong>: autenticação na aplicação e controlo de permissões;</li>
        <li><strong>Gestão de medicamentos e medições</strong>: registo e acompanhamento de informação relacionada com a toma de medicamentos e monitorização de indicadores de saúde;</li>
        <li><strong>Gestão de desafios e recompensas</strong>: participação em desafios e/ou questionários e possível atribuição de recompensas;</li>
        <li><strong>Gestão de notificações</strong>: comunicação de lembretes, alertas e informações relativas a medicamentos e medições e/ou desafios e recompensas.</li>
      </ul>
      <p>Podem ser utilizados, conforme aplicável:</p>
      <ul>
        <li>Dados de identificação, nomeadamente, o número de beneficiário do Programa <em>abem</em>:;</li>
        <li>Dados sociodemográficos, nomeadamente, o ano de nascimento;</li>
        <li>Dados de saúde, nomeadamente, registos de medicação e medições, quando fornecidos pelo utilizador;</li>
        <li>Dados de desafios, nomeadamente, respostas a questionários e progressão;</li>
        <li>Dados de benefícios, nomeadamente, benefícios recebidos.</li>
      </ul>
      <p>O tratamento de dados assenta em:</p>
      <ul>
        <li>Execução contratual com o utilizador;</li>
        <li>Consentimento do utilizador, quando este introduz voluntariamente dados de saúde na aplicação.</li>
      </ul>
      <p>A aplicação está desenvolvida de forma a respeitar a privacidade dos utilizadores, na medida em que:</p>
      <ul>
        <li>Os dados de saúde ficam guardados no telemóvel do utilizador, não sendo acedidos pela Associação Dignitude nem outros terceiros; e</li>
        <li>Os restantes dados são utilizados de forma pseudonimizada, não permitindo a identificação direta do utilizador.</li>
      </ul>
      <p>Neste contexto, os prestadores de serviços associados à aplicação apenas acedem a informação que não permite identificar diretamente o utilizador.</p>
      <p>Os dados são mantidos enquanto for beneficiário do Programa <em>abem</em>: ou até solicitar o apagamento da sua conta na aplicação. Caso deixe de ser beneficiário do Programa <em>abem</em>: ou solicite o apagamento da sua conta, os dados pessoais serão eliminados e/ou anonimizados de forma irreversível.</p>
      <p>O utilizador pode solicitar os direitos de acesso, retificação, apagamento, limitação e oposição através do e-mail: <a href="mailto:geral@dignitude.org">geral@dignitude.org</a>.</p>
      <p>Esta política pode ser revista e alterada, a qualquer momento, de forma a refletir como os dados pessoais são utilizados na aplicação.</p>
    `,
  };

  async function ensureConsent(pin, sb) {
    const existing = await getConsentStatus(pin, sb);
    if (existing && existing.consent_version === CONSENT_VERSION) {
      return existing;
    }

    const choice = await showConsentModal();
    if (!choice) return null;

    try {
      const { error } = await sb.rpc('record_consent', {
        p_pin: pin,
        p_version: CONSENT_VERSION,
        p_purposes: choice,
        p_user_agent: (navigator.userAgent || '').slice(0, 500),
        p_language: 'pt-PT',
      });
      if (error) throw error;
      return {
        consent_version: CONSENT_VERSION,
        purposes: choice,
        granted_at: new Date().toISOString(),
      };
    } catch (err) {
      console.error('Failed to record consent:', err);
      throw new Error('Não foi possível registar o consentimento. Tente novamente.');
    }
  }

  async function getConsentStatus(pin, sb) {
    try {
      const { data, error } = await sb.rpc('get_active_consent', { p_pin: pin });
      if (error) {
        console.error('Failed to fetch consent status:', error);
        return null;
      }
      if (!data || data.length === 0) return null;
      return data[0];
    } catch (err) {
      console.error('Consent status error:', err);
      return null;
    }
  }

  async function withdrawConsent(pin, sb) {
    try {
      const { error } = await sb.rpc('retirar_consentimento', { p_pin: pin });
      if (error) {
        console.error('Failed to withdraw consent:', error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('Withdraw consent error:', err);
      return false;
    }
  }

  function showConsentModal() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'consent-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'consent-title');

      overlay.innerHTML = `
        <div class="consent-modal" tabindex="-1">
          <h2 id="consent-title">${TEXT.title}</h2>
         <p id="consent-intro">${TEXT.intro}</p>
          <div class="consent-policy" tabindex="0" role="region" aria-label="Política de privacidade e proteção de dados">
            ${TEXT.policyHtml}
          </div>
      
          <p class="consent-reassurance">${TEXT.reassurance}</p>
          <p class="consent-change-mind">${TEXT.changeMind}</p>
          <div class="consent-buttons">
            <button type="button" class="consent-btn consent-btn-accept">${TEXT.buttonAccept}</button>
            <button type="button" class="consent-btn consent-btn-refuse">${TEXT.buttonRefuse}</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);
      document.body.classList.add('consent-open');

      const modalEl = overlay.querySelector('.consent-modal');
      setTimeout(() => modalEl.focus(), 50);

      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') finish(null);
      });

      overlay.querySelector('.consent-btn-accept').addEventListener('click', () => {
        const choice = { quiz: true };
        finish(choice);
      });

      overlay.querySelector('.consent-btn-refuse').addEventListener('click', () => finish(null));

      function finish(result) {
        document.body.classList.remove('consent-open');
        overlay.remove();
        resolve(result);
      }
    });
  }

  window.QMSConsent = {
    CONSENT_VERSION,
    ensureConsent,
    getConsentStatus,
    withdrawConsent,
  };
})();
