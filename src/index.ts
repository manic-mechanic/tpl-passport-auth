import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createAuth } from "./auth";
import { createDb } from "./db";
import { sql } from 'kysely'
import type { Auth } from "./auth";

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
  "https://dev.librarypassport.ca",
];

const corsMiddleware = cors({
  origin: (origin) => ALLOWED_ORIGINS.includes(origin) ? origin : null,
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  credentials: true,
  maxAge: 600,
});

app.use("/api/*", corsMiddleware);

// Module-level memoization — Worker isolate is reused across requests
let _auth: Auth | null = null;
let _authEnv: Bindings | null = null;
let _db: ReturnType<typeof createDb> | null = null;
let _dbEnv: Bindings | null = null;

function getAuth(env: Bindings): Auth {
  if (_auth && _authEnv === env) return _auth;
  _auth = createAuth(env);
  _authEnv = env;
  return _auth;
}

function getDb(env: Bindings): ReturnType<typeof createDb> {
  if (_db && _dbEnv === env) return _db;
  _db = createDb(env);
  _dbEnv = env;
  return _db;
}

// Schemas
const CheckInSchema = z.object({
  branchCode: z.string().min(1),
  timestamp: z.string().min(1),
  note: z.string().optional(),
  photoUri: z.string().url().nullable().optional(),
});

const ProfileSchema = z.object({
  name: z.string().optional(),
  homeBranch: z.string().optional(),
});

const PhotoUriSchema = z.object({
  photoUri: z.string().url().nullable(),
});

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  return getAuth(c.env).handler(c.req.raw);
});

const ALLOWED_EXTS = new Set(["jpg", "jpeg", "png", "webp", "heic"]);

app.post("/api/upload/photo", async (c) => {
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const ext = c.req.query("ext") ?? "jpg";
  if (!ALLOWED_EXTS.has(ext)) {
    return c.json({ error: "Invalid file extension" }, 400);
  }

  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    return c.json({ error: "File too large (max 10 MB)" }, 413);
  }

  const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
  const key = `photos/${session.user.id}/${crypto.randomUUID()}.${ext}`;

  await c.env.PHOTOS_BUCKET.put(key, c.req.raw.body, {
    httpMetadata: { contentType },
  });

  return c.json({ publicUrl: `${c.env.R2_PUBLIC_URL}/${key}` });
});

app.get("/api/checkins", async (c) => {
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const rows = await getDb(c.env)
    .selectFrom("check_ins")
    .select(["branch_code", "timestamp", "note", "photo_url"])
    .where("user_id", "=", session.user.id)
    .orderBy("timestamp", "desc")
    .execute();
  return c.json(rows);
});

app.post("/api/checkins", async (c) => {
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const parsed = CheckInSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);

  const { branchCode, timestamp, note, photoUri } = parsed.data;
  if (photoUri && !photoUri.startsWith(c.env.R2_PUBLIC_URL)) {
    return c.json({ error: "Invalid photoUri" }, 400);
  }

  await getDb(c.env)
    .insertInto("check_ins")
    .values({
      user_id: session.user.id,
      branch_code: branchCode,
      timestamp,
      note: note ?? "",
      photo_url: photoUri ?? null,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "timestamp"]).doUpdateSet({
        note: (eb) => eb.ref("excluded.note"),
        photo_url: (eb) => eb.ref("excluded.photo_url"),
      })
    )
    .execute();
  return c.json({ ok: true });
});

app.get('/api/profile', async (c) => {
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  const row = await getDb(c.env)
    .selectFrom('user_profile')
    .select(['name', 'home_branch'])
    .where('user_id', '=', session.user.id)
    .executeTakeFirst();
  return c.json(row ?? { name: '', home_branch: '' });
});

app.put('/api/profile', async (c) => {
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);

  const parsed = ProfileSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { name, homeBranch } = parsed.data;
  await getDb(c.env)
    .insertInto('user_profile')
    .values({ user_id: session.user.id, name: name ?? '', home_branch: homeBranch ?? '' })
    .onConflict(oc => oc
      .column('user_id')
      .doUpdateSet({
        name: eb => eb.ref('excluded.name'),
        home_branch: eb => eb.ref('excluded.home_branch'),
        updated_at: sql`datetime('now')`,
      })
    )
    .execute();
  return c.json({ ok: true });
});

app.patch("/api/checkins/:timestamp", async (c) => {
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const parsed = PhotoUriSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);

  const { photoUri } = parsed.data;
  if (photoUri && !photoUri.startsWith(c.env.R2_PUBLIC_URL)) {
    return c.json({ error: "Invalid photoUri" }, 400);
  }

  const timestamp = decodeURIComponent(c.req.param("timestamp"));
  await getDb(c.env)
    .updateTable("check_ins")
    .set({ photo_url: photoUri })
    .where("user_id", "=", session.user.id)
    .where("timestamp", "=", timestamp)
    .execute();
  return c.json({ ok: true });
});

app.get("/", (c) => c.text("tpl-passport-auth ok"));

export default app;
