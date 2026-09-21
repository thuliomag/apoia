/**
 * RASCUNHO / PONTO DE PARTIDA — Provider NextAuth v4 para o Login Único gov.br
 * -----------------------------------------------------------------------------
 * Objetivo: substituir (ou somar, se quisermos manter um fallback local) o
 * `KeycloakProvider` hoje usado em `app/api/auth/[...nextauth]/options.ts`
 * (apontado para o SSO da PJe/PDPJ — não serve para a ANM) por um login via
 * gov.br, que é o SSO padrão do Poder Executivo federal e o caminho natural
 * para servidores da ANM.
 *
 * Endpoints e parâmetros abaixo confirmados contra a documentação oficial do
 * "Roteiro de Integração do Login Único" (https://acesso.gov.br/roteiro-tecnico/)
 * em 2026-09-21:
 *   - Ambiente de staging: https://sso.staging.acesso.gov.br
 *   - Ambiente de produção: https://sso.acesso.gov.br (padrão do projeto; CONFIRMAR
 *     antes de usar — o roteiro oficial é a fonte de verdade, não este comentário)
 *   - /authorize, /token, /userinfo, /jwk, /logout
 *   - PKCE (S256) é OBRIGATÓRIO — o NextAuth v4 já cuida disso sozinho quando o
 *     provider declara `checks: ["pkce", "state"]` (usa openid-client por baixo).
 *   - Autenticação no /token via HTTP Basic (client_id:client_secret) — comportamento
 *     padrão do NextAuth, não precisa de código extra.
 *   - Claim principal do usuário no token/userinfo é `sub` = CPF (não e-mail, não
 *     username) — diferente do padrão Keycloak/PDPJ que a Apoia usa hoje
 *     (`preferred_username`). Isso é o ponto de maior atenção ao adaptar
 *     `lib/user.ts` (UserType) e qualquer lugar que hoje assume `preferredUsername`.
 *
 * PRÉ-REQUISITO ADMINISTRATIVO (fora do código): credenciamento da Apoia-ANM junto
 * à equipe do Login Único (contato oficial: integracaoid@gestao.gov.br) para obter
 * client_id/client_secret e registrar as redirect_uri/post_logout_redirect_uri.
 * Isso normalmente é feito primeiro em staging.
 *
 * STATUS: não testado (não temos client_id/client_secret reais ainda). A forma do
 * provider (endpoints, scopes, mapeamento de profile) segue o padrão documentado,
 * mas só será validada de fato no primeiro login real contra o ambiente de staging.
 */

import type { OAuthConfig, OAuthUserConfig } from 'next-auth/providers/oauth'

export type GovBrProfile = {
    sub: string          // CPF do usuário
    name?: string
    email?: string
    email_verified?: boolean
    phone_number?: string
    // Presentes se os scopes govbr_confiabilidades* forem solicitados:
    amr?: string[]        // métodos de autenticação usados (passwd, x509, app, mfa, ...)
    confiabilidades?: any[]
}

export type GovBrProviderOptions = OAuthUserConfig<GovBrProfile> & {
    /** Base do ambiente, ex.: https://sso.staging.acesso.gov.br ou https://sso.acesso.gov.br */
    issuerBaseUrl: string
    /**
     * Scopes solicitados. `openid email profile` é o mínimo para identificar o
     * usuário; adicionar `govbr_confiabilidades govbr_confiabilidades_idtoken`
     * só se formos de fato checar nível de confiabilidade da conta (ex.: exigir
     * conta prata/ouro para liberar acesso administrativo).
     */
    scope?: string
}

export default function GovBrProvider(options: GovBrProviderOptions): OAuthConfig<GovBrProfile> {
    const base = options.issuerBaseUrl.replace(/\/$/, '')
    const scope = options.scope ?? 'openid email profile'

    return {
        id: 'govbr',
        name: 'gov.br',
        type: 'oauth',
        // PKCE + state: obrigatórios pelo Login Único e tratados automaticamente
        // pelo NextAuth quando declarados aqui.
        checks: ['pkce', 'state'],
        authorization: {
            url: `${base}/authorize`,
            params: { scope, response_type: 'code' },
        },
        token: `${base}/token`,
        userinfo: `${base}/userinfo`,
        // O Login Único assina o id_token; se quisermos validar localmente em vez
        // de confiar só no transporte HTTPS + client_secret, dá para expor o JWKS
        // (`${base}/jwk`) via `jwks_endpoint` — deixado de fora deste rascunho para
        // não presumir que o NextAuth v4 valida isso da forma que esperamos sem teste.
        profile(profile: GovBrProfile) {
            return {
                id: profile.sub,           // CPF — considerar mascarar/hashear antes de logar
                name: profile.name ?? profile.sub,
                email: profile.email,
                // Campos abaixo seguem o padrão que `lib/user.ts` (UserType) já espera
                // de outros providers, para minimizar mudanças no resto do código:
                preferredUsername: profile.sub,
            } as any
        },
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        style: { logo: '/govbr-logo.svg', bg: '#1351B4', text: '#fff' }, // cores oficiais gov.br; ajustar ativo
    }
}
