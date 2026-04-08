import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";

type Bindings = {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const ALLOWED_ORIGINS = [
  "https://librarypassport.ca",
  "https://www.librarypassport.ca",
  "tplpassportrn://",
];

app.use(
  "/api/auth/*",
  cors({
    origin: (origin) =>
      ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    maxAge: 600,
  }),
);

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

app.get("/", (c) => c.text("tpl-passport-auth ok"));

export default app;
