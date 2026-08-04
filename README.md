# Mais Saúde — PWA do programa abem:

Aplicação web progressiva (PWA) de literacia em saúde para beneficiários do
programa **abem:** (Rede Solidária do Medicamento, Associação Dignitude).

Construída em HTML, CSS e JavaScript sem frameworks nem passo de compilação:
o que está no repositório é o que corre no browser. Base de dados, autenticação
e funções em Supabase. Sucede a uma versão anterior feita em FlutterFlow, cujo
modelo de dados foi adaptado.

- **Aplicação:** https://sara-timoteo.github.io/quiz-mais-saude/
- **Painel de administração:** https://sara-timoteo.github.io/quiz-mais-saude/admin/

> Estes endereços são provisórios. A aplicação destina-se a passar para um
> repositório da própria Associação Dignitude, altura em que os URLs mudam.
> O projeto Supabase mantém-se.

## O que a aplicação faz

O beneficiário entra com o **número de beneficiário abem:** e o **ano de
nascimento** — não há registo, palavra-passe nem conta a criar.

- **Quizzes por níveis**, com desbloqueio sequencial: um nível só abre quando o
  anterior está concluído. As perguntas não se repetem entre tentativas.
- **Pontos cumulativos** e **recompensas** atribuídas pelo programa.
- **Medicamentos**: registo de tomas com hora, intervalo de datas e lembretes
  por notificação.
- **Medições**: tensão arterial e glicemia, com contexto (jejum, antes ou
  depois da refeição, antes de deitar).
- **Relatório e exportação** em CSV e PDF, para levar à consulta.
- **Acessibilidade**: texto maior, alto contraste, animações reduzidas e leitura
  das páginas em voz alta (Web Speech API, voz pt-PT quando o dispositivo a tem).
- Instalável no telemóvel a partir do browser, Android e iOS.

## Painel de administração (`/admin/`)

Acesso por Supabase Auth, restrito a contas registadas na tabela `admins`.
Cinco secções: visão geral, utilizadores, pontuações, recompensas e conteúdo
do quiz.

Permite importar beneficiários e conteúdo, atribuir recompensas, e consultar
resultados. Todas as operações de escrita passam por funções `SECURITY DEFINER`
guardadas por `is_admin()`.

## Onde vivem os dados — e porquê

Esta é a decisão estruturante do projeto e convém não a desfazer sem pensar.

| Dados | Onde ficam |
|---|---|
| Medicamentos, tomas, medições | **Só no dispositivo**, cifrados |
| Número de beneficiário, ano de nascimento | Supabase (`Utilizadores`) |
| Resultados de quiz, pontos, recompensas | Supabase |
| Registo de consentimento | Supabase (`consents`) |

Os **dados de saúde nunca saem do equipamento**. Ficam em `localStorage`
cifrados com AES-GCM 256, com chave derivada do número e do ano de nascimento
por PBKDF2 (100 000 iterações). A chave existe apenas em memória durante a
sessão: fechada a sessão, ninguém a reconstrói sem as credenciais da pessoa.

## Segurança

- O beneficiário **não é autenticado no Supabase** — é `anon`. A chave anónima
  está no código do cliente, como é próprio deste modelo.
- Por isso, **`anon` não lê nem escreve tabelas**. Todo o acesso passa por
  funções `SECURITY DEFINER`. As de administração são guardadas por `is_admin()`.
- O painel é a exceção: acede a tabelas diretamente, mas autenticado.
- A chave da conta de serviço da Google vive num **segredo do Supabase**
  (`GOOGLE_SA_JSON`), nunca no browser nem neste repositório.

## Consentimento e proteção de dados

O texto de privacidade apresentado na primeira utilização reproduz o documento
aprovado pelo Encarregado de Proteção de Dados da Dignitude (15-06-2026) e está
em `consent.js`. **Qualquer alteração a esse texto passa pelo DPO.**

A versão em vigor é `CONSENT_VERSION = 'v3-2026-07'`, declarada em `sw.js`.
Cada aceitação fica registada em `consents`, com finalidades, data e versão.

Quem retira o consentimento é suspenso e pseudonimizado: os resultados e as
recompensas mantêm-se, deixando de estar associados à pessoa. A reativação
faz-se pelo painel.

## Conteúdo do quiz

Níveis e perguntas são mantidos numa **Google Sheet** pela equipa do programa,
e entram na base por um botão do painel, com pré-visualização e confirmação por
um administrador. O motivo desta escolha, e as alternativas rejeitadas, estão
em [`decisao_conteudo_google_sheets.md`](./decisao_conteudo_google_sheets.md).

Os beneficiários são importados por caminho semelhante, a partir de uma folha
privada lida por uma conta de serviço só de leitura, através da Edge Function
`ler-folha-beneficiarios`.

## Base de dados

O histórico completo dos passos aplicados à base — funções, permissões e
alterações de esquema — está em
[`supabase/MaisSaude_Fase5_BD_consolidado.sql`](./supabase/MaisSaude_Fase5_BD_consolidado.sql).

É **referência e arquivo, não um instalador**: as definições das tabelas não
estão incluídas, pelo que o ficheiro não levanta uma base vazia. As definições
das funções foram obtidas por `pg_get_functiondef()` diretamente da base, não
reconstruídas de memória.

**O ficheiro usa `CREATE OR REPLACE`:** correr secções soltas numa base em uso
substitui definições existentes. A secção 8 descreve uma função destrutiva que
está assinalada para não correr.

## Estrutura

```
index.html, app.js, style.css     aplicação do beneficiário
consent.js, consent.css           fluxo de consentimento (texto do DPO)
crypto.js                         cifra local dos dados de saúde
sw.js, manifest.json              PWA
admin/                            painel de administração
supabase/functions/               Edge Functions
supabase/*.sql                    esquema da base de dados
assets/                           logótipos abem: e Dignitude
```

Há **dois `app.js` e dois `style.css`** — um na raiz e outro em `admin/`.
São ficheiros distintos, com variáveis CSS de valores diferentes. Não copiar
regras de um para o outro sem verificar.

## Desenvolver e publicar

Não há dependências nem build. Serve-se a pasta com qualquer servidor estático:

```
python3 -m http.server 8000
```

A publicação é por **GitHub Pages**, a partir de `main`. O `.nojekyll` impede o
processamento por Jekyll.

Dois avisos práticos:

- Os *service workers* estão em **rede-primeiro**. Ainda assim, o Pages tem
  cache HTTP de cerca de 10 minutos: use **Ctrl+Shift+R** depois de publicar.
- As alterações ao esquema da base fazem-se no **SQL Editor** do Supabase, e
  depois refletem-se no ficheiro SQL acima.

## Estado

Em testes, com dados de teste sob o prefixo `TESTE-`. O projeto acompanha uma
comunicação à conferência **TEEM 2026**.
