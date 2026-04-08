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
  PHOTOS_BUCKET: R2Bucket;
  R2_BUCKET_NAME: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PUBLIC_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const ALLOWED_ORIGINS = [
  "https://librarypassport.ca",
  "https://www.librarypassport.ca",
  "tplpassportrn://",
];

const corsMiddleware = cors({
  origin: (origin) =>
    ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
  credentials: true,
  maxAge: 600,
});

app.use("/api/auth/*", corsMiddleware);
app.use("/api/upload/*", corsMiddleware);

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

const ALLOWED_EXTS = new Set(["jpg", "jpeg", "png", "webp", "heic"]);

app.post("/api/upload/photo", async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const ext = c.req.query("ext") ?? "jpg";
  if (!ALLOWED_EXTS.has(ext)) {
    return c.json({ error: "Invalid file extension" }, 400);
  }

  const { data: base64 } = await c.req.json<{ data: string }>();
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
  const key = `photos/${session.user.id}/${crypto.randomUUID()}.${ext}`;

  await c.env.PHOTOS_BUCKET.put(key, bytes, {
    httpMetadata: { contentType },
  });

  return c.json({ publicUrl: `${c.env.R2_PUBLIC_URL}/${key}` });
});

app.get("/", (c) => c.text("tpl-passport-auth ok"));

export default app;
