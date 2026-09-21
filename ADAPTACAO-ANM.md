# Apoia → ANM: diagnóstico técnico e plano de adaptação (rascunho)

Data: 2026-09-21 (fase 1) — atualizado 2026-09-21 (fases 2 e 3, ver seções 8-10)
Base: fork local de `trf2-jus-br/apoia` (branch master, commit `9ce7324`)

## 1. O que já foi validado neste ambiente

- Clone limpo do repositório público (AGPL-3.0).
- `npm install` — 1741 pacotes, sem erros (Node 20/22, ~45s).
- `npm run typecheck` — **passa limpo**, inclusive após adicionar o rascunho de
  adaptador SEI-ANM (`lib/interop/sei-anm-soap-client.ts`) e a dependência `soap`.
- **Atualização fase 3 (ver seção 9): a aplicação SOBE de ponta a ponta neste sandbox,
  sem Docker.** O `docker pull` de qualquer imagem (ex.: `mysql:8.0.21`) é bloqueado pela
  política de rede/egress deste ambiente (403 do proxy ao registry do Docker Hub) — não é
  limitação da ANM nem do código, é só deste sandbox. Mas o sandbox já tinha PostgreSQL 16
  instalado nativamente (sem Docker), e isso foi suficiente: login local, modo ADM/SEI e o
  `InteropSEI` (incluindo o cliente SOAP novo) foram validados rodando de verdade, num
  browser real. Ver seção 9 para o passo a passo (reproduzível em qualquer máquina com
  Node + Postgres OU Docker, sem depender de nada da ANM).

Conclusão prática: o código é saudável, bem documentado (`AGENTS.md` é um guia de
arquitetura muito completo) e é uma base segura para fork.

## 2. Como o "Modo SEI" da Apoia funciona hoje (achado principal)

- O modo (JUDICIAL/ADMINISTRATIVO) é decidido pela URL: prefixo `/adm` = ADMINISTRATIVO
  (`proxy.ts` injeta o header `x-apoia-mode`).
- Em modo ADMINISTRATIVO, `getInterop()` (`lib/interop/interop.ts`) sempre devolve uma
  instância de `InteropSEI` (`lib/interop/sei.ts`), que implementa a interface comum
  `Interop` (mesma interface usada pelos adapters de Eproc/MNI e PDPJ):
  ```ts
  interface Interop {
    init(): Promise<void>
    autenticar(system: string): Promise<boolean>
    consultarMetadadosDoProcesso(numeroDoProcesso: string): Promise<InteropProcessoType[]>
    consultarProcesso(numeroDoProcesso: string): Promise<DadosDoProcessoType[]>
    obterPeca(numeroDoProcesso: string, idDaPeca: string, binary?: boolean): Promise<ObterPecaType>
  }
  ```
- **Ponto-chave**: `InteropSEI` não fala com o SEI "de fábrica". Ele faz um `fetch` REST
  em `SEI_API_URL/processos/{numero}` (JSON), token Bearer reaproveitado do login
  PDPJ/DataLake do usuário. O comentário no código cita explicitamente um
  "módulo trf2/sei-rest-api-module" — **esse módulo não está nos repositórios públicos
  da organização `trf2-jus-br`** (verificado: prompts, apoia, balcaovirtual, eproc-api,
  forumjus, votejus, sistemaprocessual-api, apolo-api, csviewer, idjus, intelijus — nenhum
  é isso). Ou é interno, ou foi implementado como um módulo/extensão dentro da própria
  instalação SEI do TRF2.
- O SEI "puro" (o mesmo software que a ANM já roda como SEI-ANM) não tem REST nativo —
  expõe um **Web Service SOAP de interoperabilidade** (documentado publicamente pelo
  projeto SEI: "Manual de Web Services do SEI"; padrão confirmado também em implementações
  de terceiros como o pacote R `rsei` e o proxy `sei-soap-proxy-app`).

Ou seja: **a peça que falta para reproduzir o Modo SEI na ANM não é a Apoia — é um
tradutor entre o SOAP nativo do SEI-ANM e o formato JSON que a Apoia já sabe consumir.**
Isso é bom: é um problema pequeno e bem isolado, não uma reescrita da plataforma.

## 3. O que a Apoia já resolve para nós (reaproveitável sem tocar)

- `lib/interop/sei-mapping.ts` — `mapSeiToSimplified()` já sabe converter um objeto
  `SeiInput` (numero, nivelSigilo, tipoProcedimento, dataGeracao, orgao, interessados,
  andamentos, documentos) para o formato interno unificado da Apoia, incluindo a
  heurística de correlacionar documento → andamento por data/hora. **Não precisa
  reescrever isso** — só precisa alimentar essa função com o mesmo shape de entrada.
- Todo o resto da plataforma (banco de prompts, síntese processual, revisão de texto,
  geração de ementa/decisão, chat, busca semântica, biblioteca de documentos, anonimização,
  servidor MCP para Claude/ChatGPT) é agnóstico à origem do processo — funciona em cima
  de `DadosDoProcessoType`, então funciona igual para SEI-ANM.
- O servidor MCP (`app/api/mcp/[transport]/route.ts`, `lib/mcp/mcp-registry.ts`) também
  não precisa mudar de arquitetura — só a auth do token (hoje amarrada ao JWT PDPJ).

## 4. O que precisa ser adaptado

| Peça | Hoje (TRF2) | Para a ANM |
|---|---|---|
| Origem dos dados do processo | REST interno `SEI_API_URL` (módulo não-público) | Novo cliente SOAP direto ao SEI-ANM (rascunho em `lib/interop/sei-anm-soap-client.ts`) |
| Autenticação da chamada ao SEI | Token PDPJ/DataLake reaproveitado | Credencial de "Sistema Externo" do próprio SEI-ANM (`SiglaSistema` + `IdentificacaoServico`, cadastrada pelo admin do SEI) |
| Login do usuário na Apoia (NextAuth) | Keycloak (SSO da PJe/PDPJ) ou Credentials contra MNI de tribunal | Provider novo: gov.br (OIDC) e/ou AD/LDAP interno da ANM — mecanismo padrão do NextAuth, não é uma reescrita |
| Banco de prompts | Focado em rotina judicial + alguns administrativos do TRF2 | Curadoria própria: prompts para processos de pesquisa mineral, lavra, licenciamento, CFEM, com base no Código de Mineração e normativos da ANM |
| Multi-tenant / onboarding | Login CNJ → `seq_tribunal_pai`/`seq_órgão` | Não se aplica a um fork próprio de instância única — simplifica, não complica |

## 5. Rascunho entregue neste fork

Arquivo novo: `lib/interop/sei-anm-soap-client.ts`
- Implementa `consultarProcedimentoNoSeiAnm()` e `obterDocumentoBinarioSeiAnm()`.
- Usa a lib `soap` (adicionada ao `package.json` deste fork).
- Monta a saída no shape `SeiInput` para reusar `mapSeiToSimplified` sem alterações.
- **Os nomes de operação/campos do SOAP (`consultarProcedimento`, `SiglaSistema`,
  `IdentificacaoServico`, `IdUnidade`, etc.) seguem o padrão público do Web Service do
  SEI, mas NÃO foram testados contra um SEI real** — precisam ser confirmados contra:
  1. o WSDL publicado pelo SEI-ANM (path típico:
     `.../sei/controlador_ws.php?servico=sei&wsdl`, a confirmar com a TI da ANM);
  2. o Manual de Web Services na versão instalada na ANM.
- **Atualização fase 2**: essa troca já foi feita. `InteropSEI.init()`
  (`lib/interop/sei.ts`) agora verifica se `SEI_ANM_WSDL_URL` (eventualmente prefixada
  por tribunal) está configurada; se sim, usa `consultarProcedimentoNoSeiAnm`/
  `obterDocumentoBinarioSeiAnm` (fluxo SOAP/ANM), senão mantém o `fetch` REST original
  (fluxo `SEI_API_URL`/TRF2) intacto. Nenhuma mudança no TRF2 quando a env do SOAP não
  está setada — é puramente aditivo.
- **Atualização fase 2**: corrigido um bug de formato de data. O Web Service do SEI
  retorna datas como `AAAAMMDDHHMMSS` (14 dígitos, sem separadores — confirmado no
  Manual de Web Services do SEI), enquanto `sei-mapping.ts` espera strings ISO 8601
  para a correlação documento→andamento e `lib/interop/sei.ts` faz `new Date(dataGeracao)`.
  `parseSeiDataHora()` (novo, em `sei-anm-soap-client.ts`) faz essa conversão sem impor
  fuso horário (só reformata os dígitos).

`npm run typecheck` passa limpo com este arquivo incluído.

## 5.1. Login via gov.br (rascunho entregue)

Pesquisei o "Roteiro de Integração do Login Único" oficial (acesso.gov.br) e escrevi
um segundo rascunho: `lib/auth/govbr-provider.ts`, um provider NextAuth v4 customizado
(o NextAuth não tem um preset pronto para gov.br) que substitui o `KeycloakProvider`
hoje usado (apontado para o SSO da PJe/PDPJ, que não serve para a ANM).

Pontos confirmados contra a documentação oficial:
- Endpoints padrão OIDC: `/authorize`, `/token`, `/userinfo`, `/jwk`, `/logout`, sob
  `https://sso.staging.acesso.gov.br` (homologação) — produção precisa ser confirmada
  com a equipe do Login Único no credenciamento.
- **PKCE (S256) é obrigatório** — o NextAuth v4 já resolve isso sozinho ao declarar
  `checks: ["pkce", "state"]` no provider (é o que fiz).
- Autenticação no `/token` via HTTP Basic (`client_id:client_secret`) — padrão do
  NextAuth, sem código extra.
- A claim principal do usuário é `sub` = **CPF** (não e-mail/username, diferente do
  Keycloak/PDPJ que a Apoia usa hoje) — isso é o ponto de maior atenção ao adaptar
  `lib/user.ts` (`UserType`) e qualquer lugar que hoje assume `preferredUsername`
  no formato PDPJ.
- Cadastro do client_id/client_secret é feito junto à equipe do Login Único
  (contato oficial: `integracaoid@gestao.gov.br`), normalmente primeiro em staging.

Já pluguei o provider em `options.ts` (mesmo padrão condicional do Keycloak, atrás
de `GOVBR_ISSUER_BASE_URL`/`GOVBR_CLIENT_ID`/`GOVBR_CLIENT_SECRET`) e adicionei as
variáveis correspondentes em `lib/utils/env.ts`. Rodei `npm run typecheck` e
`npm run lint` depois da mudança — **0 erros** (245 warnings pré-existentes no
projeto, nenhum novo). Ainda não testado com um client_id real, porque isso depende
do credenciamento junto ao gov.br.

**Atualização fase 2 — dois bugs reais encontrados e corrigidos (sem depender de
credenciais gov.br, só lendo o restante do código de auth):**

1. `assertCourtId()` (`lib/user.ts`) precisa de `user.system` batendo com a env
   `SYSTEM_MAPPING` (ex. `TRF2:4`) para resolver o tribunal/órgão — senão lança
   `Não foi possível identificar o tribunal do usuário` em produção. O
   `CredentialsProvider` já seta `system` explicitamente (`app/api/login/route.ts`),
   mas o rascunho original do `GovBrProvider` não setava nada, e nem `email` nem
   `corporativo` de um usuário gov.br batem com as outras heurísticas de
   `assertCourtId` (regex `@...\.jus\.br`, `corporativo[0].seq_tribunal_pai`). Ou
   seja: **todo login via gov.br quebraria em produção** ao tentar consultar o SEI.
   Corrigido: `GovBrProvider` agora seta `system: 'ANM'` por padrão (configurável via
   `systemCode`, mas não há necessidade de ser dinâmico — instância única). Documentei
   `SYSTEM_MAPPING="ANM:1"` como obrigatório no `.env.local.example`.
2. O callback `jwt` (`options.ts`) fazia `jose.decodeJwt(account.access_token)` e, sem
   try/catch, lia `decodedToken.realm_access.roles` incondicionalmente —
   `realm_access` é uma claim específica do Keycloak. Qualquer provider cujo
   `access_token` não seja um JWT nesse formato (gov.br incluído — não há garantia de
   que o access_token do Login Único seja um JWT com essa claim, e nada nos exemplos
   analisados sugere que seja) faria esse callback **lançar exceção e derrubar o
   login inteiro**. Corrigido com try/catch + optional chaining (`realm_access?.roles`);
   comportamento para Keycloak/PDPJ não muda.

`npm run typecheck`, `npm run lint` (0 erros, 245 warnings pré-existentes) e
`npm test` (458/458) passam após as duas correções.

## 6. O que só a ANM consegue destravar (não é código)

1. Confirmar que o **Serviço de Interoperabilidade (Web Service SOAP) do SEI-ANM está
   habilitado** e obter a URL do WSDL. *(Pausado por decisão do usuário em 2026-09-21 —
   seguimos sem isso por ora.)*
2. Cadastrar a Apoia-ANM como **Sistema Externo** no SEI-ANM (gera `SiglaSistema` +
   `IdentificacaoServico`) — feito pelo administrador do SEI, sem depender de código.
3. Credenciar a Apoia-ANM junto à equipe do Login Único gov.br
   (`integracaoid@gestao.gov.br`) para obter `client_id`/`client_secret` de staging.
4. Definir onde essa instância vai rodar em homologação (um Postgres/MySQL de teste
   + um host, para sairmos do typecheck e chegarmos a uma tela funcionando).
5. Decidir se vale a pena, em paralelo, mandar um e-mail para `apoia@trf2.jus.br`
   perguntando pelo `sei-rest-api-module` — se eles toparem compartilhar, isso
   pode substituir todo o cliente SOAP por um simples proxy REST.

## 7. Próximos passos sugeridos (ordem)

1. Levantar internamente o WSDL do SEI-ANM e confirmar (com a TI/SEI da ANM) os nomes
   reais das operações — validar/corrigir `sei-anm-soap-client.ts` contra isso (a
   integração com `InteropSEI` e o parsing de data já estão prontos, só os nomes de
   campo/operação do SOAP precisam ser confirmados).
2. Pedir o cadastro de Sistema Externo no SEI-ANM (credenciais de teste).
3. Rodar `npm run dev` de fato num ambiente sem a restrição de rede deste sandbox
   (local ou de homologação da ANM), com um Postgres/MySQL real, autenticando com o
   provider Credentials (mais simples que Keycloak/gov.br para um primeiro teste) para
   ver a interface funcionando.
4. Com credenciais de teste do SEI-ANM em mãos, validar `consultarProcedimentoNoSeiAnm`
   contra um processo real de homologação.
5. Com client_id/client_secret de staging do Login Único, validar o primeiro login
   real via `GovBrProvider`.
6. Só então: prompts próprios da ANM, decisão de login definitivo, e avaliação AGPL-3.0
   com a área jurídica antes de qualquer publicação/distribuição do fork.

## 8. Fase 2 (2026-09-21) — o que deu para avançar sem depender do TI da ANM

Trabalho de continuação, focado no que **não** depende de credenciais/acesso da ANM
(WSDL do SEI-ANM, cadastro de Sistema Externo, credenciamento gov.br). Resumo — ver
detalhes inline nas seções 5/5.1 acima:

- `InteropSEI` (`lib/interop/sei.ts`) já chama o cliente SOAP quando `SEI_ANM_WSDL_URL`
  está configurada (fallback REST do TRF2 preservado, sem mudança de comportamento
  quando essa env não está setada).
- Corrigido bug de formato de data (`AAAAMMDDHHMMSS` → ISO 8601) no cliente SOAP.
- Corrigidos dois bugs reais no fluxo de autenticação que **quebrariam o login gov.br
  em produção** (detalhes na seção 5.1): `system` ausente no `GovBrProvider` (quebra
  `assertCourtId`) e `jwt` callback assumindo formato Keycloak sem try/catch.
- Novo `__tests__/sei-anm-soap-client.test.ts`: mocka o pacote `soap` com uma resposta
  sintética no formato documentado publicamente do SEI e valida o pipeline completo
  **SOAP → `SeiInput` → `mapSeiToSimplified`** (a função de mapeamento já existente e
  testada da Apoia) — incluindo a correlação documento↔andamento por data/hora e a
  conversão de data. Isso não substitui testar contra um SEI-ANM real, mas comprova que
  a lógica de mapeamento do cliente é internamente consistente com o resto da Apoia.
  `npm test`: 26 suites / 458 testes, todos passando.
- `.env.local.example` atualizado com as novas variáveis (`GOVBR_*`, `SEI_ANM_*`,
  `SYSTEM_MAPPING`) documentadas e comentadas.
- Tentei subir a aplicação de ponta a ponta via Docker (`docker run mysql:8.0.21`);
  bloqueado por política de rede deste sandbox (`docker pull` para o Docker Hub retorna
  403). **Retomado e concluído na fase 3 (seção 9) usando PostgreSQL nativo (sem
  Docker)** — a aplicação sobe e o modo ADM/SEI foi validado de verdade.

## 9. Fase 3 (2026-09-21) — aplicação rodando de ponta a ponta, validada num browser real

Objetivo desta fase: responder à pergunta "dá para testar localmente, sem depender da
TI da ANM?" com uma resposta concreta — não só "deveria funcionar", mas rodando de
verdade e clicando na tela. Resultado: **sim, dá**, e o passo a passo abaixo é
reproduzível em qualquer máquina (a própria, não precisa ser este sandbox).

### 9.1. Sem Docker: PostgreSQL nativo é suficiente

O sandbox já tinha PostgreSQL 16 instalado (sem Docker). Isso bastou:

```bash
service postgresql start   # ou: pg_ctlcluster 16 main start, fora de containers
psql -U postgres -c "ALTER USER postgres PASSWORD 'apoia';"
psql -U postgres -c "CREATE DATABASE apoia;"
```

Numa máquina com Docker funcionando normalmente (fora deste sandbox), o
`docker-compose.yaml` do próprio repo também deve funcionar — a restrição de rede era
só daqui.

### 9.2. Bug real encontrado: bootstrap do PostgreSQL do zero estava quebrado

`migrations/postgres/knex/` (a pasta que `lib/migrate-on-start.ts` roda automaticamente)
**começa em `migration-009.sql`** — as migrations 001 a 008 nunca foram portadas do lado
MySQL (`migrations/mysql/knex/`, que tem 001-033 completo). Rodar `migrations/postgres/init.sql`
(o snapshot base) e deixar a aplicação migrar sozinha falhava na `migration-020.sql`,
que já assume a coluna `ia_prompt.is_latest` (entre outras) existindo — coluna que só é
criada pela `migration-007.sql` do lado MySQL, sem equivalente Postgres.

**Corrigido**: criei `migrations/postgres/knex/migration-007.sql` e `migration-008.sql`,
traduzindo o conteúdo real das equivalentes MySQL (`is_latest`/`share` em `ia_prompt`,
tabela `ia_favorite`, colunas novas em `ia_user`, tabela `ia_user_daily_usage`) para
sintaxe Postgres (`BOOLEAN` em vez de `TINYINT(1)`, coluna gerada `GENERATED ALWAYS AS
(...) STORED` com `COALESCE` em vez de `IFNULL`, etc.). Com isso, um Postgres novo
migra do zero, de `init.sql` até a migration mais recente, numa única execução —
confirmado com `[migrate] OK em ~100ms` num banco recém-criado. Isso é útil para
qualquer um (TRF2 incluso) que tente rodar Postgres do zero; considerar reportar
upstream.

### 9.3. Login local só-para-dev (sem Keycloak, sem PDPJ, sem gov.br)

Adicionado em `app/api/auth/[...nextauth]/options.ts`, atrás de duplo gate
(`NODE_ENV=development` **e** a env `DEV_LOCAL_LOGIN=1`, nunca ativo em produção): um
provider de "login local" que autentica com um clique, sem credenciais externas, e seta
`system: 'ANM'` (igual ao `GovBrProvider`, resolvido via `SYSTEM_MAPPING`). Necessário
porque, como já registrado na seção 5.1/8, a Apoia hoje não tem NENHUM jeito de logar
sem Keycloak/PDPJ, MNI/Balcaojus ou gov.br — nenhum dos três a ANM tem.

**Dois bugs reais encontrados e corrigidos ao implementar isso** (achados testando de
verdade, não hipotéticos):

1. `CredentialsProvider(...)` (o factory do NextAuth v4) sempre devolve
   `{ id: 'credentials', name: 'Credentials', ... }` no nível superior — o `id`/`name`
   customizados passados para o factory ficam escondidos dentro de `.options`, não no
   objeto que o resto da Apoia lê diretamente. A tela de login
   (`app/(main)/auth/signin/page.jsx`) decide o que renderizar checando literalmente
   `provider.name === "Credentials"` na lista crua — com o factory, o provider de dev
   caía sempre no formulário antigo de MNI (`credentials-form.tsx`, rótulo fixo
   "Login com credenciais do Eproc"), nunca aparecia como botão próprio. Corrigido
   construindo o provider como objeto plano (sem passar pelo factory), o que também é
   o padrão suportado pelo NextAuth v4 para providers customizados.
2. `DATABASE_SECRET` (usada por `encryptWithDatabaseSecret`, `lib/utils/env.ts`) não
   estava documentada em `.env.local.example` e, sem ela, `components/user-menu.tsx`
   quebra o render de QUALQUER página (inclusive a tela de login, que usa o mesmo
   layout) com `Cryptr: secret must be a non-0-length string`. Adicionada ao
   `.env.local.example`.

### 9.4. Validação de ponta a ponta com browser real (Playwright/Chromium headless)

Com o servidor rodando (`npm run dev`) e `DEV_LOCAL_LOGIN=1` + `SYSTEM_MAPPING=ANM:1`
no `.env.local`:

1. Login via "Acessar com Login local (dev)" — cookie de sessão criado, redireciona
   para `/`.
2. `/adm` renderiza a home em modo ADMINISTRATIVO ("Chat Administrativo", "Prompts",
   "Biblioteca" etc.), com o menu mostrando "Dev Local/ANM" — confirma que login →
   `system: 'ANM'` → roteamento de modo `/adm` → `x-apoia-mode` (proxy.ts) estão todos
   conectados.
3. Chamando a API de processo em modo ADM (`GET /adm/api/v1/process/{numero}`)
   **sem** `SEI_ANM_WSDL_URL`/`SEI_API_URL` configuradas: retorna exatamente
   `{"errorMsg":"SEI_API_URL ou SEI_ANM_WSDL_URL não configurada para o tribunal do
   usuário"}` — a mensagem de erro escrita em `lib/interop/sei.ts`, não um crash. Prova
   que `getInterop` resolveu `InteropSEI`, que `assertCourtId` resolveu o tribunal via
   `SYSTEM_MAPPING`, e que o guard de configuração funciona.
4. Configurando `SEI_ANM_WSDL_URL=http://localhost:9/...` (porta proposital sem nada
   escutando) e repetindo a chamada: o erro muda para `"connect ECONNREFUSED
   127.0.0.1:9"` — prova que **o caminho SOAP** (`sei-anm-soap-client.ts`), e não mais
   o REST legado, foi o que rodou. É a confirmação mais forte possível, sem um SEI-ANM
   real, de que a integração de ponta a ponta (login → modo → InteropSEI → cliente
   SOAP) está toda conectada corretamente.

### 9.5. Como reproduzir na sua máquina

1. `git clone` do fork, `git checkout anm-adaptacao`, `npm install`.
2. Postgres local (nativo ou via `docker-compose.yaml`) numa base `apoia`.
3. `psql -f migrations/postgres/init.sql` (schema base) — as migrations 001-008 novas já
   estão em `migrations/postgres/knex/`, não precisa de mais nenhum passo manual.
4. `.env.local` com `DB_CLIENT=pg`, `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_DATABASE`,
   `NEXTAUTH_SECRET`/`JWT_SECRET`/`PWD_SECRET`/`DATABASE_SECRET` (qualquer string
   aleatória para teste local — `openssl rand -hex 32`), `MIGRATE_ON_START=1`,
   `DEV_LOCAL_LOGIN=1`, `SYSTEM_MAPPING=ANM:1`. Ver `.env.local.example`.
5. `npm run dev`, abrir `http://localhost:8081/auth/signin`, clicar em "Acessar com
   Login local (dev)", depois ir para `/adm`.
6. Quando tiver o WSDL real do SEI-ANM (seção 6, item 1): setar `SEI_ANM_WSDL_URL` e
   as demais `SEI_ANM_*` e testar `consultarProcedimentoNoSeiAnm` contra um processo
   real — é o único passo que falta e que só a ANM destrava.

## 10. Fase 3 (2026-09-21) — identidade própria (SIA-ANM), não a marca do TRF2

Feedback do usuário: o fork estava usando a marca do TRF2 (nome "Apoia", logo, texto de
login mencionando "credenciais do CNJ" — algo específico da Justiça, sem sentido para a
ANM). Objetivo declarado: aproveitar o *trabalho e a expertise* já existentes (o motor
por trás da ferramenta), mas construir algo próprio da ANM desde já — que depois, se
fizer sentido, seja levado para virar um projeto institucional.

Decisão (com o usuário): nome **SIA-ANM** (Sistema de Inteligência Artificial da ANM);
por ora só o essencial de marca — sem desenhar logo nova, só tirar o que é do TRF2 e pôr
algo neutro no lugar. Alterado:

- Nome/título em `app/(main)/layout.tsx` e `app/(sidekick)/layout.tsx` (metadata,
  `<title>`, Open Graph) — antes apontava até para o domínio de produção do TRF2
  (`apoia.pdpj.jus.br`).
- Logo do cabeçalho (`components/RootLayoutWithTheme.tsx`) e da tela de login
  (`app/(main)/auth/signin/page.jsx`): as imagens do TRF2 (`apoia-logo-*.png`) foram
  trocadas por um wordmark em texto ("SIA-ANM") — sem depender de nenhuma arte nova.
- Tela de login (`app/(main)/auth/signin/provider.tsx`): removido o texto fixo "Login
  com credenciais do CNJ" (CNJ = Conselho Nacional de Justiça — não se aplica à ANM).
- Home (`app/(main)/page.tsx`): texto de boas-vindas e "Sobre" reescritos para a ANM
  (antes dizia literalmente "para Magistrados e Servidores do Poder Judiciário" e
  "Integrada a sistemas do Judiciário, como o DataLake/Codex" — ambos incorretos para
  a ANM). Mantido, com crédito explícito: um parágrafo linkando o repositório e o
  manual originais do TRF2, deixando claro que o SIA-ANM é um fork e que a
  documentação deles ainda vale para a maior parte das funcionalidades (prompts,
  biblioteca, revisão de texto) — só a integração com o SEI é própria da ANM.

**Não alterado nesta fase** (por ser código morto para a ANM, ou por ainda ser
documentação útil, não "marca"): os textos/links de manual do TRF2 espalhados em
páginas mais profundas (`app/(main)/batch/page.tsx`, `mcp/McpPage.tsx`,
`components/non-corporate-user-warning.tsx`, `components/api-key-missing.tsx` etc.) —
continuam apontando para `trf2.gitbook.io/apoia`, que ainda documenta corretamente como
usar prompts, biblioteca, revisão de texto etc.; a UI do login MNI/Eproc
(`credentials-form.tsx`) — nunca aparece para a ANM, pois depende da env `SYSTEMS`, que
não é setada aqui; textos legais citando a Resolução CNJ nº 615/2025 sobre uso de IA
(`components/error-message.tsx`, `mcp/McpPage.tsx`) — a preocupação de fundo (LGPD) é
válida para a ANM também, mas a resolução citada é específica do Judiciário; vale
revisar com a área jurídica da ANM qual normativo equivalente citar, quando for a hora.

`npm run check` (0 erros) e `npm test` (458/458) seguem passando. Validado visualmente
num browser real (mesmo processo da seção 9.4): tela de login e home em modo ADM sem
nenhum resquício visual do TRF2, `<title>` já mostrando "SIA-ANM".

## 11. Guia rápido: rodar localmente no macOS (só terminal)

Passo a passo completo, do zero, assumindo só terminal (Terminal.app/iTerm) + Git —
sem precisar abrir o github.com em nenhum momento. Rode cada bloco em ordem; comandos
`brew`/`psql`/`npm` são idempotentes (rodar de novo não quebra nada).

**1. Ferramentas de base** (pule o que já tiver — `brew --version`, `git --version`,
`node --version` para checar):

```bash
# Homebrew (gerenciador de pacotes do macOS) — pula se `brew --version` já funcionar
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Git e Node.js 22 — pula o que já tiver
brew install git node@22
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc   # Apple Silicon
# echo 'export PATH="/usr/local/opt/node@22/bin:$PATH"' >> ~/.zshrc   # Intel — use esta linha em vez da de cima
source ~/.zshrc
```

**2. PostgreSQL local** (sem Docker — mais simples no Mac):

```bash
brew install postgresql@16
brew services start postgresql@16

# postgresql@16 é "keg-only" — o brew não coloca o psql no PATH sozinho:
echo 'export PATH="'"$(brew --prefix postgresql@16)"'/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# Cria um usuário/banco dedicados (rode só uma vez)
psql postgres -c "CREATE ROLE apoia WITH LOGIN PASSWORD 'apoia' SUPERUSER;"
psql postgres -c "CREATE DATABASE apoia OWNER apoia;"
```

**3. Clonar o repositório e entrar no branch da ANM:**

```bash
cd ~/Developer   # ou a pasta que preferir para projetos
git clone https://github.com/thuliomag/apoia.git
cd apoia
git checkout anm-adaptacao
npm install
```

**4. Carregar o schema base do banco** (as migrations seguintes rodam sozinhas
quando a aplicação sobe, graças ao 9.2/seção 8):

```bash
psql -U apoia -h 127.0.0.1 -d apoia -f migrations/postgres/init.sql
```

**5. Criar o `.env.local`** (fica só na sua máquina, nunca é commitado — já está no
`.gitignore`). Copie e cole o bloco inteiro:

```bash
cat > .env.local << 'ENVEOF'
NEXT_PUBLIC_BASE_URL=http://localhost:8081
NEXTAUTH_URL_INTERNAL=http://localhost:8081
NEXTAUTH_URL=http://localhost:8081
NEXTAUTH_SECRET=CHANGE_ME_1
JWT_SECRET=CHANGE_ME_2
JWT_ISSUER=sia-anm.local
JWT_AUDIENCE=sia-anm.local
PWD_SECRET=CHANGE_ME_3
DATABASE_SECRET=CHANGE_ME_4
CONFIDENTIALITY_LEVEL_MAX=0
MIGRATE_ON_START=1
DISABLE_DOCUMENT_CACHE=1
DB_CLIENT=pg
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=apoia
DB_PASSWORD=apoia
DB_DATABASE=apoia
DEV_LOCAL_LOGIN=1
SYSTEM_MAPPING=ANM:1
ENVEOF

# Substitui os placeholders CHANGE_ME_N por strings aleatórias de verdade:
for n in 1 2 3 4; do
  sed -i '' "s/CHANGE_ME_$n/$(openssl rand -hex 32)/" .env.local
done
```

**6. Subir a aplicação:**

```bash
npm run dev
```

Abra `http://localhost:8081/auth/signin`, clique em **"Acessar com Login local
(dev)"**, depois entre em `http://localhost:8081/adm` — é a home em modo
administrativo (SEI), já com a identidade SIA-ANM. `Ctrl+C` no terminal para parar.

**7. Para pegar atualizações minhas depois** (sem precisar abrir o GitHub):

```bash
cd ~/Developer/apoia   # ou onde você clonou
git checkout anm-adaptacao
git pull origin anm-adaptacao
npm install   # só se package.json tiver mudado
npm run dev
```

**Problemas comuns:**
- `psql: command not found` → `brew link postgresql@16` (ou abra um terminal novo
  depois do `brew install`).
- Porta 8081 ocupada → algum `npm run dev` antigo ainda rodando; `Ctrl+C` nele ou
  `lsof -i :8081` para achar o processo e `kill <PID>`.
- Erro de migration ao rodar `npm run dev` pela primeira vez → confirme que rodou o
  passo 4 (`init.sql`) antes.
