import CredentialsProvider from "next-auth/providers/credentials"
import KeycloakProvider from "next-auth/providers/keycloak"
import GovBrProvider from "@/lib/auth/govbr-provider"
// import jwt from 'jsonwebtoken'
import * as jose from "jose"
import { envString } from "@/lib/utils/env"

const authOptions = {
  secret: envString('NEXTAUTH_SECRET') as string,
  // Configure one or more authentication providers
  providers: [] as any[],
  session: {
    // strategy: 'jwt',
    maxAge: 8 * 60 * 60 // 8 hours
  },
  cookies: {
    sessionToken: {
      name: process.env.NODE_ENV === 'production' 
        ? '__Secure-next-auth.session-token' 
        : 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: true,
      },
    },
    callbackUrl: {
      name: process.env.NODE_ENV === 'production'
        ? '__Secure-next-auth.callback-url'
        : 'next-auth.callback-url',
      options: {
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: true,
      },
    },
    csrfToken: {
      name: process.env.NODE_ENV === 'production'
        ? '__Host-next-auth.csrf-token'
        : 'next-auth.csrf-token',
      options: {
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: true,
      },
    },
  },
  callbacks: {
    async jwt({ token, user, account }) {
      let roles = undefined as
        | { [key: string]: { roles: Array<any> } }
        | undefined
      let corporativo = undefined as any[]
      let preferredUsername = undefined as string
      let iss = undefined as string

      if (account?.access_token) {
        // decodeJwt lança se access_token não for um JWT (ex.: token opaco), e
        // realm_access é uma claim específica do Keycloak — ausente em outros
        // providers (ex.: Login Único gov.br). Sem o try/catch e o optional
        // chaining, login via qualquer provider não-Keycloak quebra aqui.
        try {
          const decodedToken: any = jose.decodeJwt(account.access_token)
          if (decodedToken && typeof decodedToken !== "string") {
            roles = decodedToken.realm_access?.roles
            corporativo = decodedToken.corporativo
            preferredUsername = decodedToken.preferred_username
            iss = decodedToken.iss
          }
        } catch (e) {
          console.error('Não foi possível decodificar access_token como JWT:', e)
        }
      }
      token = { roles, corporativo, preferredUsername, iss, accessToken: account?.access_token, ...token, ...user }

      // Renova o token MCP (ia_mcp_token) a cada login: atualiza o JWT PDPJ encriptado e o
      // expires_at mantendo o token_id estável, para que a URL já configurada no cliente MCP
      // não precise ser regerada. Import dinâmico evita ciclo options.ts → mcp-token.dao →
      // lib/user.ts → options.ts. Falhas não podem quebrar a autenticação (tratadas no DAO).
      const freshJwt = account?.access_token ?? (user as any)?.accessToken
      if (freshJwt) {
        try {
          const decoded: any = jose.decodeJwt(freshJwt)
          if (decoded?.preferred_username && decoded?.exp) {
            const { McpTokenDao } = await import('@/lib/db/dao/mcp-token.dao')
            await McpTokenDao.refreshForUsername(decoded.preferred_username, freshJwt, new Date(decoded.exp * 1000))
          }
        } catch (e) {
          console.error('MCP token refresh on login error:', e)
        }
      }
      return token
    },
    async session({ session, token, user }) {
      // Send properties to the client, like an access_token from a provider.
      session.user = token
      return session
    },
  },
  pages: {
    signIn: "/auth/signin",
  },
}

// GithubProvider({
//   clientId: envString('CSVIEWER_GITHUB_ID'),
//   clientSecret: envString('CSVIEWER_GITHUB_SECRET'),
// }),
if (envString('SYSTEMS')) {
  authOptions.providers.push(CredentialsProvider({
    // The name to display on the sign in form (e.g. "Sign in with...")
    name: "Credentials",
    // `credentials` is used to generate a form on the sign in page.
    // You can specify which fields should be submitted, by adding keys to the `credentials` object.
    // e.g. domain, username, password, 2FA token, etc.
    // You can pass any HTML attribute to the <input> tag through the object.
    credentials: {
      system: {
        label: "System",
        type: "text",
        placeholder: "Enter System",
      },
      email: {
        label: "Email",
        type: "text",
        placeholder: "Enter email",
      },
      password: {
        label: "Password",
        type: "password",
        placeholder: "Enter Password",
      },
    },

    async authorize(credentials, req) {
      const system = credentials?.system
      let email = credentials?.email
      let password = credentials?.password

      const res = await fetch(
        `${envString('NEXTAUTH_URL_INTERNAL') as string}/api/login`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            system,
            email,
            password,
          }),
        },
      )
      const user = await res.json()
      if (res.ok && user) {
        return user
      } else return null
    },
  }))
}

if (envString('KEYCLOAK_ISSUER')) {

  authOptions.providers.push(KeycloakProvider({
    clientId: 'apoia',
    clientSecret: envString('KEYCLOAK_CREDENTIALS_SECRET') as string,
    issuer: envString('KEYCLOAK_ISSUER'),
  }))

}

// RASCUNHO (fork ANM): login via Login Único gov.br, no lugar do Keycloak/PDPJ.
// Ver lib/auth/govbr-provider.ts para o detalhamento e o que falta validar
// (client_id/client_secret reais, endpoint de produção vs. staging).
if (envString('GOVBR_ISSUER_BASE_URL')) {

  authOptions.providers.push(GovBrProvider({
    issuerBaseUrl: envString('GOVBR_ISSUER_BASE_URL') as string,
    clientId: envString('GOVBR_CLIENT_ID') as string,
    clientSecret: envString('GOVBR_CLIENT_SECRET') as string,
    scope: envString('GOVBR_SCOPE'),
  }))

}

export default authOptions
