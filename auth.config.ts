/**
 * Used by the BetterAuth CLI (migrate, generate).
 * Reads from process.env / .env — not the Workers runtime bindings.
 */
import { betterAuth } from "better-auth";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { expo } from '@better-auth/expo'

const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

export default betterAuth({
  baseURL: process.env.BETTER_AUTH_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,

  database: {
    dialect,
    type: "sqlite",
  },

  emailAndPassword: {
    enabled: true,
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },

  trustedOrigins: [
    "https://librarypassport.ca",
    "https://www.librarypassport.ca",
    "tplpassportrn://",
  ],
  plugins: [expo()],
});
