// Mais Saude - ler-folha-beneficiarios
// Le a Google Sheet PRIVADA de beneficiarios com a conta de servico
// e devolve as linhas em JSON. NAO escreve nada na base de dados:
// a gravacao e feita pelo painel, com a sessao da admin, via RPC
// importar_beneficiarios (que valida is_admin por dentro).

const SHEET_ID = "1ZBetET41k2gn1dC812efzfYj-U84kG_odDxj5Y4m_RM";
const ABA = "beneficiarios";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function pemToBinary(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "")
                 .replace(/-----END PRIVATE KEY-----/, "")
                 .replace(/\s+/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

function b64url(data: string | Uint8Array): string {
  const s = typeof data === "string"
    ? btoa(data)
    : btoa(String.fromCharCode(...data));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(sa: Record<string, string>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claim));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBinary(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
  );
  const jwt = unsigned + "." + b64url(sig);

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Google recusou o token: " + JSON.stringify(j));
  return j.access_token;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const bruto = Deno.env.get("GOOGLE_SA_JSON");
    if (!bruto) throw new Error("Falta o segredo GOOGLE_SA_JSON.");

    let sa: Record<string, string>;
    try {
      sa = JSON.parse(bruto);
    } catch {
      throw new Error("GOOGLE_SA_JSON nao e JSON valido.");
    }
    if (!sa.client_email || !sa.private_key) {
      throw new Error("GOOGLE_SA_JSON sem client_email ou private_key.");
    }

    const token = await getAccessToken(sa);

    const url = "https://sheets.googleapis.com/v4/spreadsheets/" + SHEET_ID +
                "/values/" + encodeURIComponent(ABA);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    const dados = await r.json();

    if (!r.ok) {
      const msg = dados?.error?.message || JSON.stringify(dados);
      throw new Error("Google Sheets recusou: " + msg);
    }

    const valores: string[][] = dados.values || [];
    if (valores.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, linhas: [], aviso: "A folha esta vazia." }),
        { headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const cab = valores[0].map((c) => String(c || "").trim().toLowerCase());
    const iPin = cab.indexOf("numbeneficiario");
    const iAno = cab.indexOf("anonascimento");

    if (iPin === -1 || iAno === -1) {
      throw new Error(
        "Cabecalhos nao encontrados. Esperado numbeneficiario e anonascimento; " +
        "encontrado: " + cab.join(", "),
      );
    }

    const linhas = valores.slice(1)
      .map((l) => ({
        numbeneficiario: String(l[iPin] ?? "").trim(),
        anonascimento: String(l[iAno] ?? "").trim(),
      }))
      .filter((o) => o.numbeneficiario !== "" || o.anonascimento !== "");

    return new Response(
      JSON.stringify({ ok: true, total: linhas.length, linhas }),
      { headers: { ...cors, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, erro: String(e?.message || e) }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
});
