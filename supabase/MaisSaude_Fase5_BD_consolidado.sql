-- ############################################################################
-- MAIS SAÚDE — FASE 5 · REFERÊNCIA CONSOLIDADA (base de dados)
-- ----------------------------------------------------------------------------
-- Reúne TODOS os passos de BD já instalados no Supabase (hhozgecuyczrbvyzvaoz),
-- por ordem de aplicação. É REFERÊNCIA / arquivo.
-- Seguro re-correr: usa CREATE OR REPLACE / IF NOT EXISTS / DROP IF EXISTS.
--
--   1) Importação em massa: tabela auditoria + RPC importar_beneficiarios
--   2) Limpeza de testes: RPC limpar_beneficiarios_de_teste
--   3) Retirar/reativar · P1: colunas estado + pseudonimo + sequência
--   4) Retirar/reativar · P2: retirar_consentimento (reescrita)
--   5) Retirar/reativar · P3: verificar_beneficiario (bloqueio por estado)
--   6) Retirar/reativar · P4: reativar_beneficiario (botão da dashboard)
--   7) Login bloqueado: consentimento_retirado (mensagem específica na app)
--   8) REFERÊNCIA (não correr): limpar_dados_de_teste — função ANTERIOR à Fase 5
--   9) Níveis D2: nivel_concluido, nivel_desbloqueado, cadeado em
--      obter_perguntas_do_nivel, get_estado_percurso com desbloqueado/concluido
--  10) Pontos cumulativos: get_pontos (1 ponto = 1 resposta certa)
--  11) Consentimento: get_active_consent (referência) + record_consent
--      IDEMPOTENTE (guarda + trinco). Instalado em 2026-08-03, 6.ª sessão.
--  12) REFERÊNCIA: as seis funções ANTERIORES à Fase 5 — is_admin,
--      get_resultados, get_recompensas, registar_tentativa,
--      sincronizar_conteudo, pseudonimizar_beneficiario — mais a tabela de
--      permissões lida de pg_proc.proacl (12.7). Fundida em 2026-08-04
--      (8.ª sessão); até aí vivia em ficheiro separado.
--
-- ÂMBITO — LER ANTES DE CONTAR OU DE CORRER:
--
--   * Este ficheiro NÃO levanta uma base vazia. Das nove tabelas do projeto,
--     só a importacoes_beneficiarios_log tem CREATE TABLE (secção 1). As
--     outras oito — Utilizadores, niveis, quiz_questoes, respostas_dadas,
--     resultados, recompensas, consents, admins — só aparecem em ALTER TABLE
--     e dentro das funções. É referência e arquivo, não instalador.
--
--   * Contam-se aqui 19 corpos de função. A vigésima da lista do handover é a
--     limpar_dados_de_teste, que está DESCRITA na secção 8 e não tem corpo
--     em lado nenhum. É deliberado: ver o aviso dessa secção.
--
-- PASSO 5 (dashboard admin) — FEITO em 2026-07-29, no GitHub. Ver handover.
-- NÍVEIS D2 — FEITO em 2026-07-29 (2.ª sessão). origin/main = 0e2c1bc.
-- PONTOS CUMULATIVOS — FEITO em 2026-07-29 (3.ª sessão). origin/main = 7dd0f59.
-- ############################################################################

-- ===================== 1) IMPORTAÇÃO EM MASSA =====================
-- ============================================================================
-- MAIS SAÚDE — FASE 5, PASSO 1
-- Tabela de auditoria + RPC importar_beneficiarios
-- Correr UMA VEZ no SQL Editor do Supabase (não vai para o GitHub).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) TABELA DE AUDITORIA
--    Regista SÓ contagens + quem + quando. NUNCA guarda PINs (minimização).
-- ----------------------------------------------------------------------------
create table if not exists public.importacoes_beneficiarios_log (
  id              bigint generated always as identity primary key,
  executado_por   uuid,
  executado_em    timestamptz not null default now(),
  origem          text,
  total_recebidos int not null default 0,
  inseridos       int not null default 0,
  atualizados     int not null default 0,
  ignorados       int not null default 0
);

alter table public.importacoes_beneficiarios_log enable row level security;

-- Só admins autenticados LEEM o histórico (o painel acede a tabelas diretamente).
-- Sem policies de insert/update/delete: só a RPC SECURITY DEFINER escreve.
drop policy if exists "admin_le_log_importacoes" on public.importacoes_beneficiarios_log;
create policy "admin_le_log_importacoes"
  on public.importacoes_beneficiarios_log
  for select
  to authenticated
  using (public.is_admin());

-- ----------------------------------------------------------------------------
-- 2) RPC importar_beneficiarios
--    is_admin() + SECURITY DEFINER. UPSERT por numbeneficiario (nunca apaga).
--    Valida PIN e ano. Devolve contagens + detalhe dos ignorados (transitório).
-- ----------------------------------------------------------------------------
create or replace function public.importar_beneficiarios(
  p_lista  jsonb,
  p_origem text default 'painel-admin'
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_ano_atual        int := extract(year from now())::int;
  v_total            int;
  v_inseridos        int;
  v_atualizados      int;
  v_ignorados        int;
  v_detalhe          jsonb;
begin
  -- Só admin
  if not public.is_admin() then
    raise exception 'Acesso negado: apenas administradores.' using errcode = '42501';
  end if;

  -- A entrada tem de ser um array JSON
  if p_lista is null or jsonb_typeof(p_lista) <> 'array' then
    raise exception 'p_lista tem de ser um array JSON.' using errcode = '22023';
  end if;

  -- Normalizar cada linha recebida (com número de linha para relatório)
  create temp table _entrada on commit drop as
  select
    ordinality as linha,
    nullif(btrim(elem->>'numbeneficiario'), '') as pin,
    case
      when btrim(coalesce(elem->>'anonascimento','')) ~ '^-?\d+$'
        then btrim(elem->>'anonascimento')::int
      else null
    end as ano,
    elem->>'anonascimento' as ano_bruto
  from jsonb_array_elements(p_lista) with ordinality as t(elem, ordinality);

  select count(*) into v_total from _entrada;

  -- Classificar: atribuir motivo de erro (se houver)
  create temp table _classificado on commit drop as
  select
    linha, pin, ano,
    case
      when pin is null then 'PIN vazio'
      when ano is null then 'Ano inválido: ' || coalesce(nullif(btrim(ano_bruto), ''), '(vazio)')
      when ano < 1900 or ano > v_ano_atual
        then 'Ano fora do intervalo (1900–' || v_ano_atual || '): ' || ano
      else null
    end as erro
  from _entrada;

  -- Entre as VÁLIDAS, numerar ocorrências do mesmo PIN (o lote pode ter repetidos)
  create temp table _validas_num on commit drop as
  select linha, pin, ano,
         row_number() over (partition by pin order by linha) as ocorrencia
  from _classificado
  where erro is null;

  -- Linhas a gravar = válidas e 1.ª ocorrência do PIN no lote
  create temp table _validos on commit drop as
  select pin, ano from _validas_num where ocorrencia = 1;

  -- Contar inseridos vs atualizados ANTES do upsert
  select
    count(*) filter (where u.numbeneficiario is null),
    count(*) filter (where u.numbeneficiario is not null)
  into v_inseridos, v_atualizados
  from _validos v
  left join "Utilizadores" u on u.numbeneficiario = v.pin;

  -- UPSERT (nunca apaga; PIN é PK)
  insert into "Utilizadores" (numbeneficiario, anonascimento)
  select pin, ano from _validos
  on conflict (numbeneficiario) do update
    set anonascimento = excluded.anonascimento;

  -- Ignorados (erros + duplicados no lote) — devolvidos ao admin, NÃO persistidos
  with ign as (
    select linha, pin, erro as motivo
    from _classificado where erro is not null
    union all
    select linha, pin, 'Duplicado no lote' as motivo
    from _validas_num where ocorrencia > 1
  )
  select
    count(*),
    coalesce(jsonb_agg(jsonb_build_object(
      'linha', linha,
      'numbeneficiario', pin,
      'motivo', motivo
    ) order by linha), '[]'::jsonb)
  into v_ignorados, v_detalhe
  from ign;

  -- Auditoria: SÓ contagens (sem PINs)
  insert into public.importacoes_beneficiarios_log
    (executado_por, origem, total_recebidos, inseridos, atualizados, ignorados)
  values
    (auth.uid(), p_origem, v_total, v_inseridos, v_atualizados, coalesce(v_ignorados, 0));

  -- Resposta ao admin (o detalhe é transitório, para correção imediata)
  return jsonb_build_object(
    'total_recebidos',   v_total,
    'inseridos',         v_inseridos,
    'atualizados',       v_atualizados,
    'ignorados',         coalesce(v_ignorados, 0),
    'detalhe_ignorados', v_detalhe
  );
end;
$$;

-- Fechar a porta ao anónimo; só autenticados (o guard is_admin() é interno)
revoke all on function public.importar_beneficiarios(jsonb, text) from anon, public;
grant execute on function public.importar_beneficiarios(jsonb, text) to authenticated;

-- ===================== 2) LIMPEZA DE TESTES =======================
-- ============================================================================
-- MAIS SAÚDE — FASE 5, PASSO 2
-- RPC limpar_beneficiarios_de_teste()
-- Apaga SÓ os beneficiarios com prefixo 'TESTE-' e todos os seus rastos.
-- O prefixo esta FIXO no codigo (nao e parametro) para evitar apagar dados reais.
-- Correr UMA VEZ no SQL Editor do Supabase.
-- ============================================================================

create or replace function public.limpar_beneficiarios_de_teste()
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_respostas   int := 0;
  v_resultados  int := 0;
  v_recompensas int := 0;
  v_consents    int := 0;
  v_utilizadores int := 0;
begin
  -- Só admin
  if not public.is_admin() then
    raise exception 'Acesso negado: apenas administradores.' using errcode = '42501';
  end if;

  -- Apagar os filhos primeiro (evita qualquer conflito de chave estrangeira),
  -- cada tabela pelo seu proprio nome de coluna do numero de beneficiario.

  delete from public.respostas_dadas
    where numbeneficiario like 'TESTE-%';
  get diagnostics v_respostas = row_count;

  delete from public.resultados
    where numero_beneficiario like 'TESTE-%';
  get diagnostics v_resultados = row_count;

  delete from public.recompensas
    where numero_beneficiario like 'TESTE-%';
  get diagnostics v_recompensas = row_count;

  delete from public.consents
    where beneficiary_pin like 'TESTE-%';
  get diagnostics v_consents = row_count;

  -- Por fim, os proprios registos de beneficiario
  delete from public."Utilizadores"
    where numbeneficiario like 'TESTE-%';
  get diagnostics v_utilizadores = row_count;

  return jsonb_build_object(
    'utilizadores_apagados', v_utilizadores,
    'respostas_apagadas',    v_respostas,
    'resultados_apagados',   v_resultados,
    'recompensas_apagadas',  v_recompensas,
    'consentimentos_apagados', v_consents
  );
end;
$$;

revoke all on function public.limpar_beneficiarios_de_teste() from anon, public;
grant execute on function public.limpar_beneficiarios_de_teste() to authenticated;

-- =========== 3) RETIRAR/REATIVAR · P1 (esquema) ===================
-- ============================================================================
-- MAIS SAÚDE — FASE 5 · Feature retirar/reativar — PASSO 1 (esquema)
-- Acrescenta a Utilizadores: estado + pseudonimo, e uma sequencia para o nº.
-- NAO toca em numbeneficiario nem em anonascimento (protege as medicoes cifradas).
-- Correr UMA VEZ no SQL Editor do Supabase.
-- ============================================================================

-- 1) Estado do beneficiario (por omissao 'ativo' para todos os existentes)
alter table public."Utilizadores"
  add column if not exists estado text not null default 'ativo';

alter table public."Utilizadores"
  drop constraint if exists utilizadores_estado_check;
alter table public."Utilizadores"
  add constraint utilizadores_estado_check
  check (estado in ('ativo', 'consentimento_retirado'));

-- 2) Pseudonimo — etiqueta so para a dashboard; so preenchido ao retirar
alter table public."Utilizadores"
  add column if not exists pseudonimo text;

-- Unico apenas quando existe: os ativos ficam NULL e nao colidem entre si
create unique index if not exists ux_utilizadores_pseudonimo
  on public."Utilizadores" (pseudonimo)
  where pseudonimo is not null;

-- 3) Sequencia para o numero sequencial do pseudonimo (00001, 00002, ...)
create sequence if not exists public.seq_pseudonimo
  as bigint start with 1 increment by 1 minvalue 1;

-- === 4) RETIRAR/REATIVAR · P2 (retirar_consentimento) =============
-- ============================================================================
-- MAIS SAÚDE — FASE 5 · Feature retirar/reativar — PASSO 2
-- Reescreve retirar_consentimento (funcao INTEIRA).
-- Continua a ser chamada pelo BENEFICIARIO (sem is_admin), do perfil na app.
-- Agora, alem de marcar o ledger: suspende (estado) e atribui pseudonimo.
-- NUNCA toca em numbeneficiario nem em anonascimento. NAO apaga resultados.
-- Idempotente: chamar duas vezes nao gera novo pseudonimo nem gasta sequencia.
-- Correr UMA VEZ no SQL Editor do Supabase.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.retirar_consentimento(p_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_estado     text;
  v_pseudonimo text;
BEGIN
  IF p_pin IS NULL OR length(trim(p_pin)) = 0 THEN
    RAISE EXCEPTION 'PIN vazio';
  END IF;

  -- 1) Registar a retirada no ledger de consentimento (como antes)
  UPDATE public.consents
     SET withdrawn_at = now()
   WHERE beneficiary_pin = p_pin
     AND withdrawn_at IS NULL;

  -- 2) Ler o estado atual do beneficiario (se existir)
  SELECT estado, pseudonimo
    INTO v_estado, v_pseudonimo
    FROM public."Utilizadores"
   WHERE numbeneficiario = p_pin;

  -- 3) Se existir e ainda estiver ativo: suspender + atribuir pseudonimo.
  --    Idempotente: se ja estava retirado, nao mexe (nem gasta sequencia).
  IF FOUND AND v_estado IS DISTINCT FROM 'consentimento_retirado' THEN
    IF v_pseudonimo IS NULL THEN
      v_pseudonimo := lpad(nextval('public.seq_pseudonimo')::text, 5, '0');
    END IF;

    UPDATE public."Utilizadores"
       SET estado     = 'consentimento_retirado',
           pseudonimo = v_pseudonimo
     WHERE numbeneficiario = p_pin;
  END IF;

  RETURN true;
END;
$function$;

-- === 5) RETIRAR/REATIVAR · P3 (verificar_beneficiario) ============
-- ============================================================================
-- MAIS SAÚDE — FASE 5 · Feature retirar/reativar — PASSO 3
-- Reescreve verificar_beneficiario (funcao INTEIRA) para bloquear o login
-- de quem retirou consentimento: so entra quem esta 'ativo'.
-- Mantem tudo o resto igual (PIN + ano). Correr UMA VEZ no SQL Editor.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.verificar_beneficiario(p_numero text, p_ano integer)
 RETURNS TABLE(numbeneficiario text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT u.numbeneficiario
  FROM public."Utilizadores" u
  WHERE u.numbeneficiario = p_numero
    AND u.anonascimento   = p_ano
    AND u.estado          = 'ativo'
  LIMIT 1;
END;
$function$;

-- === 6) RETIRAR/REATIVAR · P4 (reativar_beneficiario) =============
-- ============================================================================
-- MAIS SAÚDE — FASE 5 · Feature retirar/reativar — PASSO 4
-- RPC reativar_beneficiario(p_pin): is_admin() + SECURITY DEFINER.
-- Repoe o acesso (estado 'ativo') e limpa o pseudonimo (invariante:
-- tem pseudonimo <=> esta retirado).
-- IMPORTANTE: NAO mexe no consentimento — este e RE-RECOLHIDO na app a
-- proxima entrada (o admin nao consente pela pessoa). So devolve o acesso.
-- Correr UMA VEZ no SQL Editor do Supabase.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reativar_beneficiario(p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_estado_ant text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Acesso negado: apenas administradores.' USING errcode = '42501';
  END IF;

  IF p_pin IS NULL OR length(trim(p_pin)) = 0 THEN
    RAISE EXCEPTION 'PIN vazio';
  END IF;

  SELECT estado INTO v_estado_ant
    FROM public."Utilizadores"
   WHERE numbeneficiario = p_pin;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Beneficiario inexistente: %', p_pin;
  END IF;

  -- Repor acesso + limpar pseudonimo. Nao toca no consentimento (ledger).
  UPDATE public."Utilizadores"
     SET estado     = 'ativo',
         pseudonimo = NULL
   WHERE numbeneficiario = p_pin;

  RETURN jsonb_build_object(
    'numbeneficiario', p_pin,
    'estado_anterior', v_estado_ant,
    'estado',          'ativo'
  );
END;
$function$;

revoke all on function public.reativar_beneficiario(text) from anon, public;
grant execute on function public.reativar_beneficiario(text) to authenticated;


-- ===== 7) LOGIN BLOQUEADO · mensagem específica ====================
-- ============================================================================
-- MAIS SAUDE — FASE 5 · consentimento_retirado(p_numero, p_ano)
-- Permite a app distinguir "dados errados" de "consentimento retirado" e dar
-- uma mensagem especifica (contactar a Dignitude).
-- So devolve true a quem acerta no numero E no ano — as mesmas credenciais que
-- dariam acesso normal. Para dados errados devolve false, para que a app
-- mantenha a mensagem generica (nao permite enumeracao de beneficiarios).
-- NAO substitui a verificar_beneficiario: essa continua a ser o unico travao
-- do login. Esta funcao so informa.
-- Correr UMA VEZ no SQL Editor. (Instalada em 2026-07-29.)
-- ============================================================================

create or replace function public.consentimento_retirado(p_numero text, p_ano integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_retirado boolean;
begin
  select true into v_retirado
    from public."Utilizadores" u
   where u.numbeneficiario = p_numero
     and u.anonascimento   = p_ano
     and u.estado          = 'consentimento_retirado'
   limit 1;

  return coalesce(v_retirado, false);
end;
$function$;

revoke all on function public.consentimento_retirado(text, integer) from public;
grant execute on function public.consentimento_retirado(text, integer) to anon, authenticated;

-- ===== 8) REFERENCIA — limpar_dados_de_teste (NAO CORRER) =========
-- ============================================================================
-- Funcao ANTERIOR a Fase 5, ja instalada. Aqui SO para registo/auditoria.
-- Descoberta em 2026-07-29 ao ligar o botao novo de limpeza.
--
-- O QUE FAZ: apaga TODAS as linhas de resultados, recompensas e consents —
-- de TODOS os beneficiarios, reais incluidos. Os DELETE nao tem WHERE.
-- Guardas: is_admin() + frase exata 'APAGAR DADOS DE TESTE' (fixa no SQL;
-- se se mudar a frase no JS sem mudar aqui, o botao deixa de funcionar).
--
-- DUAS LACUNAS CONHECIDAS:
--  a) NAO apaga respostas_dadas — sobra dado pessoal e a logica de
--     nao-repeticao continua a achar que a pessoa ja respondeu.
--  b) Apagar consents destroi o registo que PROVA o consentimento
--     (RGPD Art. 7(1): tem de se conseguir demonstrar). Inofensivo antes do
--     lancamento, grave depois de haver consentimentos reais.
--
-- DECISAO PENDENTE (momento 0): usar uma vez e depois `drop function`, ou
-- manter adormecida. Ver handover.
--
-- NAO CONFUNDIR com limpar_beneficiarios_de_teste() (ponto 2 deste ficheiro),
-- que so apaga o prefixo TESTE- e é a que tem botao em Utilizadores.
-- ============================================================================

-- ===== 9) NIVEIS D2 · sequencia 1-2-3 com desbloqueio ==============
-- ============================================================================
-- MAIS SAUDE — FASE 5 · NIVEIS D2 (instalado em 2026-07-29, 2.a sessao)
--
-- REGRA: ronda = niveis.num_perguntas (=9 nos tres niveis).
--   O nivel N+1 desbloqueia quando N esta concluido:
--     total(N) > 0 AND respondidas(N) >= least(num_perguntas(N), total(N))
--   ou seja: uma ronda completa OU esgotar o nivel, o que vier primeiro.
--   Sem nota minima. Desbloqueio PERMANENTE (respondidas so cresce).
--   Repetir puxa so perguntas por responder (nao-repeticao da Fase 4 intacta).
--   Nivel sem perguntas NAO desbloqueia o seguinte (erro de conteudo visivel).
--   So olha para o nivel imediatamente anterior, por niveis.ordem.
--
-- ARMADILHA: num_perguntas e ao mesmo tempo o TAMANHO DA RONDA e o LIMIAR
-- de desbloqueio. Subir um nivel de 9 para 12 volta a trancar quem ja tinha
-- desbloqueado com 9. Se se quiserem rondas maiores, separar os dois numeros.
--
-- Correr por esta ordem no SQL Editor. Os passos 9.3 e 9.4 substituem
-- funcoes da Fase 4 (o corpo original esta preservado, so acrescem guardas).
-- ============================================================================

-- --------------------------------------------------------------------------
-- 9.1) nivel_concluido — auxiliar. Nunca chamada de fora.
-- --------------------------------------------------------------------------
create or replace function public.nivel_concluido(p_pin text, p_nivel bigint)
returns boolean
language plpgsql
stable
security definer
set search_path = 'public'
as $function$
declare
  v_ronda       int;
  v_total       int;
  v_respondidas int;
begin
  select coalesce(n.num_perguntas, 5) into v_ronda
    from public.niveis n where n.id = p_nivel;
  if not found then
    return false;
  end if;

  select count(*) into v_total
    from public.quiz_questoes q where q.id_niveis = p_nivel;

  -- Nivel sem perguntas NAO desbloqueia o seguinte
  if v_total = 0 then
    return false;
  end if;

  select count(*) into v_respondidas
    from public.respostas_dadas r
    join public.quiz_questoes q on q.id = r.id_questao
   where r.numbeneficiario = p_pin
     and q.id_niveis = p_nivel;

  -- Uma ronda completa OU o nivel esgotado, o que vier primeiro
  return v_respondidas >= least(v_ronda, v_total);
end;
$function$;

-- --------------------------------------------------------------------------
-- 9.2) nivel_desbloqueado — auxiliar. Olha so para o nivel anterior.
-- --------------------------------------------------------------------------
create or replace function public.nivel_desbloqueado(p_pin text, p_nivel bigint)
returns boolean
language plpgsql
stable
security definer
set search_path = 'public'
as $function$
declare
  v_ordem    int;
  v_anterior bigint;
begin
  select n.ordem into v_ordem
    from public.niveis n where n.id = p_nivel;
  if not found then
    return false;
  end if;

  -- Nivel sem ordem definida: nao bloqueia ninguem
  if v_ordem is null then
    return true;
  end if;

  select n.id into v_anterior
    from public.niveis n
   where n.ordem is not null
     and n.ordem < v_ordem
   order by n.ordem desc
   limit 1;

  -- Nao ha anterior => e o primeiro => sempre aberto
  if not found then
    return true;
  end if;

  return public.nivel_concluido(p_pin, v_anterior);
end;
$function$;

-- Ninguem de fora chama estas: so as RPCs, por dentro (SECURITY DEFINER)
revoke all on function public.nivel_concluido(text, bigint)    from anon, authenticated, public;
revoke all on function public.nivel_desbloqueado(text, bigint) from anon, authenticated, public;

-- --------------------------------------------------------------------------
-- 9.3) obter_perguntas_do_nivel — acresce o cadeado.
--      Mesma assinatura => CREATE OR REPLACE chega, permissoes intactas.
--      A regra vive na BD: quem chame a RPC pela consola tambem e travado.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_perguntas_do_nivel(p_pin text, p_nivel bigint)
 RETURNS TABLE(id integer, questao text, opcao_1 text, opcao_2 text, opcao_3 text, opcao_correta integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."Utilizadores" WHERE numbeneficiario = p_pin) THEN
    RAISE EXCEPTION 'Beneficiario inexistente';
  END IF;

  SELECT COALESCE(n.num_perguntas, 5) INTO v_n
    FROM public.niveis n WHERE n.id = p_nivel;
  IF v_n IS NULL THEN
    RAISE EXCEPTION 'Nivel inexistente';
  END IF;

  -- Cadeado sequencial (D2)
  IF NOT public.nivel_desbloqueado(p_pin, p_nivel) THEN
    RAISE EXCEPTION 'Nivel bloqueado' USING errcode = '42501';
  END IF;

  RETURN QUERY
  SELECT q.id, q.questao, q.opcao_1, q.opcao_2, q.opcao_3, q.opcao_correta
    FROM public.quiz_questoes q
   WHERE q.id_niveis = p_nivel
     AND NOT EXISTS (
       SELECT 1 FROM public.respostas_dadas r
        WHERE r.numbeneficiario = p_pin AND r.id_questao = q.id
     )
   ORDER BY random()
   LIMIT v_n;
END;
$function$;

-- --------------------------------------------------------------------------
-- 9.4) get_estado_percurso — acrescenta 'desbloqueado' e 'concluido'.
--
--      *** ATENCAO: PRECISA DE DROP ***
--      O CREATE OR REPLACE nao altera a assinatura de retorno, e o DROP leva
--      as permissoes atras. Os GRANT do fim sao OBRIGATORIOS: o beneficiario
--      entra por PIN, sem Supabase Auth, ou seja e 'anon'. Sem o grant a anon,
--      NENHUM beneficiario consegue abrir o ecra dos niveis.
--      Correr o bloco todo de seguida (entre o drop e o create a app fica sem
--      a funcao). PUBLIC fica deliberadamente de fora.
-- --------------------------------------------------------------------------
drop function if exists public.get_estado_percurso(text);

CREATE OR REPLACE FUNCTION public.get_estado_percurso(p_pin text)
 RETURNS TABLE(id bigint, nome text, ordem integer, num_perguntas integer,
               total_perguntas integer, respondidas integer, esgotado boolean,
               melhor_percentagem integer, desbloqueado boolean, concluido boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."Utilizadores" WHERE numbeneficiario = p_pin) THEN
    RAISE EXCEPTION 'Beneficiario inexistente';
  END IF;

  RETURN QUERY
  SELECT n.id, n.nome, n.ordem, n.num_perguntas,
         COALESCE(tot.c, 0)::int,
         COALESCE(resp.c, 0)::int,
         (COALESCE(resp.c,0) >= COALESCE(tot.c,0) AND COALESCE(tot.c,0) > 0),
         melhor.p,
         public.nivel_desbloqueado(p_pin, n.id),
         public.nivel_concluido(p_pin, n.id)
    FROM public.niveis n
    LEFT JOIN (SELECT id_niveis, count(*) c FROM public.quiz_questoes GROUP BY id_niveis) tot
      ON tot.id_niveis = n.id
    LEFT JOIN (SELECT q.id_niveis, count(*) c
                 FROM public.respostas_dadas r
                 JOIN public.quiz_questoes q ON q.id = r.id_questao
                WHERE r.numbeneficiario = p_pin
                GROUP BY q.id_niveis) resp
      ON resp.id_niveis = n.id
    LEFT JOIN (SELECT id_nivel, max(percentagem) p
                 FROM public.resultados
                WHERE numero_beneficiario = p_pin
                GROUP BY id_nivel) melhor
      ON melhor.id_nivel = n.id
   ORDER BY n.ordem NULLS LAST, n.id;
END;
$function$;

revoke all on function public.get_estado_percurso(text) from public;
grant execute on function public.get_estado_percurso(text) to anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 9.5) VERIFICACOES (so leitura) — correr depois, com um PIN de teste
-- --------------------------------------------------------------------------
-- Regra por nivel (esperado num utilizador novo: true / false / false):
--   select n.ordem, n.nome,
--          public.nivel_concluido('TESTE-0002', n.id)    as concluido,
--          public.nivel_desbloqueado('TESTE-0002', n.id) as desbloqueado
--     from public.niveis n order by n.ordem;
--
-- Cadeado a funcionar (a 1.a da 9, a 2.a tem de dar ERRO 'Nivel bloqueado'):
--   select count(*) from public.obter_perguntas_do_nivel('TESTE-0002', 1);
--   select count(*) from public.obter_perguntas_do_nivel('TESTE-0002', 2);
--
-- Permissoes repostas (tem de trazer anon, authenticated e service_role):
--   select p.proacl from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'get_estado_percurso';
-- ============================================================================

-- ===================== 10) PONTOS CUMULATIVOS =====================
-- ============================================================================
-- MAIS SAUDE — FASE 5 · get_pontos (instalado em 2026-07-29, 3.a sessao)
--
-- REGRA: 1 ponto = 1 resposta certa, contada uma unica vez por pergunta.
--   Sai da respostas_dadas (correta = true), que ja e o ledger: a
--   registar_tentativa grava com ON CONFLICT DO NOTHING, portanto cada
--   pergunta so conta uma vez, para sempre.
--   Nao ha contador guardado - conta-se na hora, como no nivel_concluido.
--   Retroativo por construcao. Sem limiares, sem atribuicao automatica.
--
-- ARMADILHA ASSUMIDA: o DO NOTHING congela a primeira resposta. Quem errou a
-- primeira nunca mais ganha aquele ponto, porque a obter_perguntas_do_nivel
-- nao repete perguntas ja respondidas. O teto de cada pessoa e desigual.
-- Foi por isso que se decidiu NAO haver limiares. Rever antes de os criar.
--
-- O JOIN a quiz_questoes e deliberado: so contam respostas a perguntas que
-- ainda existem. Verificado em 2026-07-29: respostas_orfas = 0.
--
-- Funcao NOVA - nao substitui nem faz DROP de nada.
-- Usada pelos DOIS lados: app.js (anon) e admin/app.js (authenticated).
-- O admin usa esta RPC e NAO a tabela, porque a RLS devolve zero linhas sem
-- dar erro - um cartao a dizer "0 de 0" pareceria normal.
-- ============================================================================

create or replace function public.get_pontos(p_pin text)
returns table(pontos integer, respondidas integer)
language plpgsql
stable
security definer
set search_path = 'public'
as $function$
begin
  if not exists (select 1 from public."Utilizadores" where numbeneficiario = p_pin) then
    raise exception 'Beneficiario inexistente';
  end if;

  return query
  select count(*) filter (where r.correta)::int,
         count(*)::int
    from public.respostas_dadas r
    join public.quiz_questoes q on q.id = r.id_questao
   where r.numbeneficiario = p_pin;
end;
$function$;

-- O beneficiario entra por PIN, sem Supabase Auth: e 'anon'.
-- PUBLIC fica deliberadamente de fora.
revoke all on function public.get_pontos(text) from public;
grant execute on function public.get_pontos(text) to anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 10.1) VERIFICACOES (so leitura)
-- --------------------------------------------------------------------------
-- Numeros de um PIN de teste:
--   select * from public.get_pontos('TESTE-0002');
--
-- O JOIN esta a deitar fora alguma coisa? Esperado: 0
--   select count(*) as respostas_orfas
--     from public.respostas_dadas r
--     left join public.quiz_questoes q on q.id = r.id_questao
--    where q.id is null;
--
-- Permissoes (tem de trazer anon, authenticated e service_role):
--   select p.proacl from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'get_pontos';
-- ============================================================================

-- ===== 11) CONSENTIMENTO · record_consent IDEMPOTENTE ==============
-- ============================================================================
-- MAIS SAUDE — FASE 5 · record_consent com guarda de idempotencia
-- Instalado em 2026-08-03 (6.a sessao). origin/main na altura = c26ce46.
--
-- PORQUE: no TESTE-9001 apareceram DUAS linhas em consents com 2,3 segundos
--   de intervalo. O withdrawn_at da primeira e o granted_at da segunda eram
--   IGUAIS AO MICROSSEGUNDO — prova de que foram escritas pela MESMA
--   transacao, ou seja, pelo proprio record_consent (que fecha a linha
--   aberta e insere uma nova). NINGUEM retirou consentimento.
--
-- CAUSA: o loginForm nao desativava o botao (app.js:148). Dois envios
--   concorrentes -> duas modais -> duas chamadas a record_consent.
--   A guarda do lado do browser esta no commit c26ce46. Esta e a da BD.
--
-- O QUE MUDA: se ja existir consentimento ATIVO com a MESMA versao e os
--   MESMOS purposes, devolve o id existente e NAO escreve nada.
--   Se os purposes mudarem, cria linha nova — como deve ser.
--
-- NOTA AO DPO: uma segunda aceitacao identica deixa de gerar linha no
--   ledger. Defende-se que a segunda linha nao era prova de um ato novo,
--   era o eco de um duplo clique.
--
-- O QUE NAO RESOLVE ISTO (testado e descartado): um indice unico parcial
--   em consents(beneficiary_pin) where withdrawn_at is null. Como o
--   record_consent fecha a anterior e abre a nova NA MESMA TRANSACAO, no
--   fim ha sempre uma so linha aberta: o indice fica satisfeito e deixa
--   passar o duplicado na mesma.
--
-- CREATE OR REPLACE com a MESMA assinatura: NAO ha DROP, por isso as
--   permissoes do anon MANTEM-SE (nao e preciso repor o grant).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 11.1) get_active_consent — REFERENCIA, nao mudou nesta sessao.
--       Registada aqui porque faltava ao consolidado.
--       "Ativo" = withdrawn_at IS NULL, o mais recente.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_active_consent(p_pin text)
 RETURNS TABLE(consent_version text, purposes jsonb, granted_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT c.consent_version, c.purposes, c.granted_at
    FROM public.consents c
   WHERE c.beneficiary_pin = p_pin
     AND c.withdrawn_at IS NULL
   ORDER BY c.granted_at DESC
   LIMIT 1;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 11.2) record_consent — VERSAO NOVA (instalada 2026-08-03)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_consent(
  p_pin text, p_version text, p_purposes jsonb,
  p_user_agent text DEFAULT NULL::text, p_language text DEFAULT 'pt-PT'::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id BIGINT;
BEGIN
  IF p_pin IS NULL OR length(trim(p_pin)) = 0 THEN
    RAISE EXCEPTION 'PIN cannot be empty';
  END IF;
  IF p_version IS NULL OR length(trim(p_version)) = 0 THEN
    RAISE EXCEPTION 'Consent version is required';
  END IF;
  IF p_purposes IS NULL THEN
    RAISE EXCEPTION 'Purposes JSON is required';
  END IF;

  -- Trinco por pessoa: serializa chamadas concorrentes do mesmo PIN.
  -- Sem ele, duas chamadas verdadeiramente simultaneas leem ambas
  -- "nao ha nada" antes de qualquer uma gravar. Liberta-se sozinho
  -- no fim da transacao.
  PERFORM pg_advisory_xact_lock(hashtext(p_pin));

  -- GUARDA: consentimento ativo igual ja existe -> devolve-o, nao escreve.
  SELECT c.id INTO v_id
    FROM public.consents c
   WHERE c.beneficiary_pin  = p_pin
     AND c.withdrawn_at IS NULL
     AND c.consent_version  = p_version
     AND c.purposes         = p_purposes
   ORDER BY c.granted_at DESC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  UPDATE public.consents
     SET withdrawn_at = now()
   WHERE beneficiary_pin = p_pin
     AND withdrawn_at IS NULL;

  INSERT INTO public.consents (
    beneficiary_pin, consent_version, purposes,
    granted_via, user_agent, language
  )
  VALUES (
    p_pin, p_version, p_purposes,
    'app', p_user_agent, COALESCE(p_language, 'pt-PT')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 11.3) VERIFICACAO (corre no SQL Editor: record_consent nao tem is_admin)
-- ----------------------------------------------------------------------------
-- Repetir um consentimento que ja existe. Esperado: devolve o id ANTIGO
-- e a tabela fica IGUAL (mesmo granted_at, sem linha nova).
--   select public.record_consent(
--     'TESTE-9002', 'v3-2026-07', '{"quiz":true}'::jsonb, 'teste', 'pt-PT');
--   select id, beneficiary_pin, granted_at, withdrawn_at
--     from consents where beneficiary_pin like 'TESTE-%' order by id;
--
-- VALIDADO em 2026-08-03: devolveu o id 25, granted_at inalterado,
-- nenhuma linha nova. Quatro linhas no total (22, 23, 24, 25).
-- ============================================================================

-- =====================================================================
-- 12) REFERÊNCIA — funções anteriores à Fase 5
-- =====================================================================
-- Estas seis funções são anteriores à Fase 5 e não constavam do ficheiro
-- consolidado, apesar de aparecerem na lista "Estado técnico" do handover.
-- Ficam aqui registadas para que o consolidado seja auto-suficiente: quem
-- recomeçar só com este ficheiro consegue reconstruir a base inteira.
--
-- Definições obtidas por pg_get_functiondef() diretamente da base.
-- NÃO foram reconstruídas de memória.
--
-- CUIDADO: são todas CREATE OR REPLACE. Correr esta secção numa base viva
-- substitui as definições atuais. Só correr numa base nova ou depois de
-- confirmar que o que está na base é igual ao que está aqui.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 12.1) is_admin()  — guarda de TODAS as RPC de administração
-- ---------------------------------------------------------------------
-- Depende da tabela public.admins (user_id uuid). É a peça de que tudo o
-- resto depende: criar primeiro, antes de qualquer função que a invoque.

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid());
END;
$function$;


-- ---------------------------------------------------------------------
-- 12.2) get_resultados(p_pin, p_limite)
-- ---------------------------------------------------------------------
-- Leitura dos resultados de um beneficiário. Filtra por p_pin; não valida
-- sessão nem ano de nascimento — quem souber o número lê os resultados.

CREATE OR REPLACE FUNCTION public.get_resultados(p_pin text, p_limite integer DEFAULT 50)
 RETURNS SETOF resultados
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT * FROM public.resultados
   WHERE numero_beneficiario = p_pin
   ORDER BY criado_em DESC
   LIMIT p_limite;
$function$;


-- ---------------------------------------------------------------------
-- 12.3) get_recompensas(p_pin)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_recompensas(p_pin text)
 RETURNS SETOF recompensas
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT *
    FROM public.recompensas
   WHERE numero_beneficiario = p_pin
   ORDER BY criado_em DESC;
$function$;


-- ---------------------------------------------------------------------
-- 12.4) registar_tentativa(p_pin, p_id_nivel, p_nivel_nome, p_respostas)
-- ---------------------------------------------------------------------
-- Regista uma tentativa de quiz. Três notas importantes:
--
-- (a) A percentagem é calculada sobre as perguntas RESPONDIDAS NESSA
--     TENTATIVA (v_total), não sobre o num_perguntas do nível. Combinado
--     com o never-repeat abaixo, quem repete um nível recebe só as
--     perguntas ainda não vistas — e pode fechar com 100% sobre 2
--     perguntas, enquanto quem fez as 9 de uma vez e errou uma fica com 89%.
--     ISTO CONDICIONA QUALQUER RANKING ORDENADO POR PERCENTAGEM.
--
-- (b) Não verifica nivel_desbloqueado. O desbloqueio sequencial é
--     garantido do lado do cliente, não aqui.
--
-- (c) Não valida sessão nem ano de nascimento, e tem EXECUTE para anon.

CREATE OR REPLACE FUNCTION public.registar_tentativa(p_pin text, p_id_nivel bigint, p_nivel_nome text, p_respostas jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total integer; v_acertos integer; v_percent integer; v_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."Utilizadores" WHERE numbeneficiario = p_pin) THEN
    RAISE EXCEPTION 'Beneficiario inexistente';
  END IF;
  IF p_respostas IS NULL OR jsonb_typeof(p_respostas) <> 'array'
     OR jsonb_array_length(p_respostas) = 0 THEN
    RAISE EXCEPTION 'Sem respostas para registar';
  END IF;

  -- total e acertos (só perguntas reais E do nível indicado)
  SELECT count(*)::int,
         count(*) FILTER (WHERE q.opcao_correta = (e->>'escolhida')::int)::int
    INTO v_total, v_acertos
    FROM jsonb_array_elements(p_respostas) e
    JOIN public.quiz_questoes q
      ON q.id = (e->>'id_questao')::int AND q.id_niveis = p_id_nivel;

  IF v_total = 0 THEN
    RAISE EXCEPTION 'Nenhuma pergunta valida para este nivel';
  END IF;
  v_percent := round(v_acertos::numeric / v_total * 100)::int;

  -- never-repeat (idempotente)
  INSERT INTO public.respostas_dadas (numbeneficiario, id_questao, correta)
  SELECT p_pin, q.id, (q.opcao_correta = (e->>'escolhida')::int)
    FROM jsonb_array_elements(p_respostas) e
    JOIN public.quiz_questoes q
      ON q.id = (e->>'id_questao')::int AND q.id_niveis = p_id_nivel
  ON CONFLICT (numbeneficiario, id_questao) DO NOTHING;

  -- resultado (mesmas colunas do guardar_resultado)
  INSERT INTO public.resultados
    (numero_beneficiario, id_nivel, nivel_nome, total_perguntas, acertos, percentagem)
  VALUES (p_pin, p_id_nivel, p_nivel_nome, v_total, v_acertos, v_percent)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;


-- ---------------------------------------------------------------------
-- 12.5) sincronizar_conteudo(p_niveis, p_questoes)
-- ---------------------------------------------------------------------
-- Importa níveis e perguntas a partir de dois arrays JSON (folha Google).
-- NOTA: num_perguntas assume 5 por omissão quando a coluna vem vazia
--       (COALESCE(..., 5)). Confirmar que os níveis reais têm o valor
--       explícito, para não ficarem silenciosamente com 5.

CREATE OR REPLACE FUNCTION public.sincronizar_conteudo(p_niveis jsonb, p_questoes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_niveis integer; v_questoes integer;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Apenas administradores podem sincronizar conteudo.';
  END IF;
  IF p_niveis IS NULL OR jsonb_typeof(p_niveis) <> 'array'
     OR p_questoes IS NULL OR jsonb_typeof(p_questoes) <> 'array' THEN
    RAISE EXCEPTION 'Dados invalidos (esperado dois arrays JSON).';
  END IF;

  INSERT INTO public.niveis (id, nome, ordem, num_perguntas)
  SELECT (e->>'id')::bigint, e->>'nome',
         NULLIF(e->>'ordem','')::int,
         COALESCE(NULLIF(e->>'num_perguntas','')::int, 5)
    FROM jsonb_array_elements(p_niveis) e
  ON CONFLICT (id) DO UPDATE
    SET nome = EXCLUDED.nome, ordem = EXCLUDED.ordem,
        num_perguntas = EXCLUDED.num_perguntas;
  GET DIAGNOSTICS v_niveis = ROW_COUNT;

  INSERT INTO public.quiz_questoes
    (id, id_niveis, questao, opcao_1, opcao_2, opcao_3, opcao_correta)
  SELECT (e->>'id')::int, (e->>'id_niveis')::bigint,
         e->>'questao', e->>'opcao_1', e->>'opcao_2', e->>'opcao_3',
         (e->>'opcao_correta')::int
    FROM jsonb_array_elements(p_questoes) e
  ON CONFLICT (id) DO UPDATE
    SET id_niveis = EXCLUDED.id_niveis, questao = EXCLUDED.questao,
        opcao_1 = EXCLUDED.opcao_1, opcao_2 = EXCLUDED.opcao_2,
        opcao_3 = EXCLUDED.opcao_3, opcao_correta = EXCLUDED.opcao_correta;
  GET DIAGNOSTICS v_questoes = ROW_COUNT;

  RETURN jsonb_build_object('niveis_sincronizados', v_niveis,
                            'questoes_sincronizadas', v_questoes);
END;
$function$;


-- ---------------------------------------------------------------------
-- 12.6) pseudonimizar_beneficiario(p_pin)
-- ---------------------------------------------------------------------
-- NÃO USAR na operação corrente. O circuito aprovado pelo DPO é o
-- retirar_consentimento / reativar_beneficiario (secção 5).
--
-- Porquê não usar: substitui o numbeneficiario por um ANON-XXXXXXXX em
-- resultados, recompensas, consents e Utilizadores, e põe anonascimento
-- a NULL. Não apaga registos — mas o número ORIGINAL desaparece sem ficar
-- guardado em lado nenhum. A reativar_beneficiario não a consegue desfazer,
-- porque não há para onde voltar. E não escreve em nenhuma tabela de
-- auditoria: não fica rasto de quem correu, quando, nem sobre quem.
--
-- É a única das seis sem EXECUTE para anon/PUBLIC. Manter assim.

CREATE OR REPLACE FUNCTION public.pseudonimizar_beneficiario(p_pin text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_novo text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Apenas administradores podem pseudonimizar.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public."Utilizadores" WHERE numbeneficiario = p_pin) THEN
    RAISE EXCEPTION 'Beneficiario inexistente';
  END IF;

  -- gerar um pseudónimo único (ex.: ANON-3F9A1C08)
  LOOP
    v_novo := 'ANON-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public."Utilizadores" WHERE numbeneficiario = v_novo);
  END LOOP;

  -- manter os registos, trocando o número por toda a base
  UPDATE public.resultados  SET numero_beneficiario = v_novo WHERE numero_beneficiario = p_pin;
  UPDATE public.recompensas SET numero_beneficiario = v_novo WHERE numero_beneficiario = p_pin;
  UPDATE public.consents
     SET beneficiary_pin = v_novo,
         withdrawn_at = COALESCE(withdrawn_at, now())
   WHERE beneficiary_pin = p_pin;

  -- por fim, o próprio registo: novo número + remover o ano de nascimento
  UPDATE public."Utilizadores"
     SET numbeneficiario = v_novo,
         anonascimento   = NULL
   WHERE numbeneficiario = p_pin;

  RETURN v_novo;
END;
$function$;


-- =====================================================================
-- 12.7) PERMISSÕES — estado atual (lido de pg_proc.proacl)
-- =====================================================================
-- "=X/postgres" no início da lista significa que PUBLIC tem EXECUTE.
--
--   função                       PUBLIC  anon  authenticated  service_role
--   ---------------------------  ------  ----  -------------  ------------
--   is_admin                       X      X          X             X
--   get_resultados                 X      X          X             X
--   get_recompensas                X      X          X             X
--   registar_tentativa             X      X          X             X
--   sincronizar_conteudo           X      X          X             X   <-- rever
--   pseudonimizar_beneficiario     -      -          X             X       (correto)
--
-- A sincronizar_conteudo é função de administração e tem EXECUTE para
-- anon. O is_admin() lá dentro segura a porta (auth.uid() vem NULL para
-- anónimos), mas a superfície não devia existir. A pseudonimizar_
-- beneficiario mostra o padrão correto, já aplicado no projeto.
--
-- Correção sugerida — NÃO CORRER sem decidir e sem testar o painel a
-- seguir, porque o painel autentica-se e mantém o acesso:
--
--   REVOKE EXECUTE ON FUNCTION public.sincronizar_conteudo(jsonb, jsonb)
--     FROM anon, PUBLIC;
--
-- POR VERIFICAR: correr a mesma consulta para importar_beneficiarios,
-- limpar_beneficiarios_de_teste, retirar_consentimento e
-- reativar_beneficiario, e ver quais têm anon.
--
--   select p.proname, p.proacl::text
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('importar_beneficiarios','limpar_beneficiarios_de_teste',
--                        'retirar_consentimento','reativar_beneficiario');
-- =====================================================================
