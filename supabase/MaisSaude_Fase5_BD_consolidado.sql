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
