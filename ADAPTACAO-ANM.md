# Apoia → ANM: diagnóstico técnico e plano de adaptação (rascunho)

Data: 2026-09-21
Base: fork local de `trf2-jus-br/apoia` (branch master, commit `9ce7324`)

## 1. O que já foi validado neste ambiente

- Clone limpo do repositório público (AGPL-3.0).
- `npm install` — 1741 pacotes, sem erros (Node 20/22, ~45s).
- `npm run typecheck` — **passa limpo**, inclusive após adicionar o rascunho de
  adaptador SEI-ANM (`lib/interop/sei-anm-soap-client.ts`) e a dependência `soap`.
- Não foi possível subir a aplicação de ponta a ponta (`npm run dev` + banco) neste
  sandbox porque não há Docker-in-Docker nem Postgres/MySQL disponíveis aqui — isso
  precisa ser feito num ambiente de desenvolvimento real (local ou de homologação da ANM).

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
- Depois de validado, o único ponto de integração com o restante da Apoia é trocar,
  em `lib/interop/sei.ts`, o método privado `consultarProcessoSei` (hoje um `fetch` REST)
  para chamar `consultarProcedimentoNoSeiAnm` — o resto da classe (`consultarProcesso`,
  `consultarMetadadosDoProcesso`) não muda.

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
   reais das operações — validar/corrigir `sei-anm-soap-client.ts` contra isso.
2. Pedir o cadastro de Sistema Externo no SEI-ANM (credenciais de teste).
3. Subir um Postgres local (ou usar o `docker-compose.yaml` do próprio repo, que já
   sobe MySQL) e rodar `npm run dev` de fato, autenticando com o provider Credentials
   (mais simples que Keycloak para um primeiro teste) para ver a interface funcionando.
4. Com credenciais de teste do SEI-ANM em mãos, validar `consultarProcedimentoNoSeiAnm`
   contra um processo real de homologação.
5. Só então: prompts próprios da ANM, decisão de login definitivo, e avaliação AGPL-3.0
   com a área jurídica antes de qualquer publicação/distribuição do fork.
