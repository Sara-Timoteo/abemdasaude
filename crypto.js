/* ============================================================
   abem: da Saúde — At-rest encryption helpers (Web Crypto API).
   
   Carregar antes do app.js:
   <script src="./crypto.js"></script>
   <script src="./consent.js"></script>
   <script src="./app.js"></script>
   
   Estratégia: AES-GCM 256-bit · chave derivada do PIN+ano via PBKDF2 100k.
   A chave existe apenas em memória durante a sessão.
   Dados antigos em plaintext continuam a ser lidos correctamente (backward compat).
   ============================================================ */

(function () {
  'use strict';

  const ENC_PREFIX = 'enc:v1:';
  const PBKDF2_ITERATIONS = 100000;
  const KEY_LENGTH = 256;

  let sessionKey = null;

  async function deriveSessionKey(pin, year) {
    if (!pin || !year) throw new Error('PIN e ano são necessários');
    const enc = new TextEncoder();
    const material = await crypto.subtle.importKey(
      'raw',
      enc.encode(String(pin) + ':' + String(year)),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    const salt = enc.encode('quiz-mais-saude-v1-' + String(pin));
    sessionKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
    return sessionKey;
  }

  async function secureSet(key, value) {
    if (!sessionKey) throw new Error('Sem chave de sessão — chame deriveSessionKey primeiro');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      sessionKey,
      enc.encode(JSON.stringify(value))
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    localStorage.setItem(key, ENC_PREFIX + bytesToBase64(combined));
  }

  async function secureGet(key) {
    const stored = localStorage.getItem(key);
    if (stored === null) return null;

    // Backward compat: plaintext legacy → parse JSON
    if (!stored.startsWith(ENC_PREFIX)) {
      try { return JSON.parse(stored); }
      catch { return stored; }
    }

    if (!sessionKey) throw new Error('Sem chave de sessão');

    try {
      const combined = base64ToBytes(stored.slice(ENC_PREFIX.length));
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        sessionKey,
        ciphertext
      );
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (err) {
      console.error('secureGet decryption failed for', key, err);
      return null;
    }
  }

  function secureDelete(key) {
    localStorage.removeItem(key);
  }

  function lockSession() {
    sessionKey = null;
  }

  function isUnlocked() {
    return sessionKey !== null;
  }

  async function migrateToEncrypted(keys) {
    if (!sessionKey) throw new Error('Sem chave de sessão');
    let migrated = 0;
    for (const key of keys) {
      const stored = localStorage.getItem(key);
      if (stored === null) continue;
      if (stored.startsWith(ENC_PREFIX)) continue;
      try {
        const value = JSON.parse(stored);
        await secureSet(key, value);
        migrated++;
      } catch (e) {
        try {
          await secureSet(key, stored);
          migrated++;
        } catch (e2) {
          console.warn('Não foi possível migrar a chave', key, e2);
        }
      }
    }
    return migrated;
  }

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Expor API global
  window.QMSCrypto = {
    deriveSessionKey,
    secureSet,
    secureGet,
    secureDelete,
    lockSession,
    isUnlocked,
    migrateToEncrypted,
  };
})();
