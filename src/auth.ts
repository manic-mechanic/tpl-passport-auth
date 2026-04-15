import { betterAuth } from "better-auth";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { expo } from '@better-auth/expo'
import { TRUSTED_ORIGINS } from './config'

export function createAuth(env: {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}) {
  const dialect = new LibsqlDialect({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,

    database: {
      dialect,
      type: "sqlite",
    },

    emailAndPassword: {
      enabled: true,
    },

    user: {
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: true,
      },
    },

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },

    trustedOrigins: TRUSTED_ORIGINS,
    plugins: [expo()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
