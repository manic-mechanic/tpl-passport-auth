import { Hono } from "hono";
import { cors } from "hono/cors";
import { sentry } from "@sentry/hono/cloudflare";
import { z } from "zod";
import { createAuth } from "./auth";
import { createDb } from "./db";
import { sql } from 'kysely'
import type { Auth } from "./auth";
import { ALLOWED_ORIGINS } from "./config";
import { saveCheckIn } from "./checkins";
import { isCanonicalCheckInTimestamp, isUserPhotoUrl, readBodyWithLimit } from "./validation";
import { checkPhotoQuota } from "./uploadLimits";

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
  // A DSN is a public key (the web app's HTML includes this one), so it's
  // set in wrangler.toml [vars]. Unset or empty means Sentry stays off: tests
  // don't set it, and .dev.vars sets it empty for `wrangler dev`.
  SENTRY_DSN?: string;
  // Workers Rate Limiting binding (wrangler.toml [[ratelimits]]). Optional so
  // tests can run without one.
  PHOTO_UPLOAD_LIMITER?: RateLimit;
};

const app = new Hono<{ Bindings: Bindings }>();

// Report errors to Sentry, first so it covers every route. This server
// handles passwords, session cookies and OAuth codes, so collect nothing
// from requests beyond the method and path: no headers, cookies, bodies,
// query strings or user info. Errors only, no tracing.
app.use(sentry(app, (env: Bindings) => ({
  dsn: env.SENTRY_DSN,
  enabled: !!env.SENTRY_DSN,
  environment: "production",
  initialScope: { tags: { service: "auth" } },
  tracesSampleRate: 0,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    databaseQueryData: false,
    stackFrameVariables: false,
  },
})));

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
  timestamp: z.string().refine(isCanonicalCheckInTimestamp, "Expected an ISO UTC timestamp (Date#toISOString)"),
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

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  return getAuth(c.env).handler(c.req.raw);
});

// A photo URL that's already on this check-in is accepted unchanged, so
// re-sending a check-in (e.g. to edit its note) keeps working for photos
// stored before the per-user key check.
async function isStoredPhotoUrl(
  db: ReturnType<typeof createDb>,
  userId: string,
  timestamp: string,
  photoUri: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("check_ins")
    .select("photo_url")
    .where("user_id", "=", userId)
    .where("timestamp", "=", timestamp)
    .executeTakeFirst();
  return row?.photo_url === photoUri;
}

const ALLOWED_EXTS = new Set(["jpg", "jpeg", "png", "webp", "heic"]);

app.post("/api/upload/photo", async (c) => {
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const ext = c.req.query("ext") ?? "jpg";
  if (!ALLOWED_EXTS.has(ext)) {
    return c.json({ error: "Invalid file extension" }, 400);
  }

  // Limits per user: see src/uploadLimits.ts.
  if (c.env.PHOTO_UPLOAD_LIMITER) {
    const { success } = await c.env.PHOTO_UPLOAD_LIMITER.limit({ key: session.user.id });
    if (!success) {
      c.header("Retry-After", "60");
      return c.json({ error: "Too many uploads, try again in a minute" }, 429);
    }
  }

  const upload = await readBodyWithLimit(c.req.raw.body, c.req.header("content-length"));
  if (!upload.ok) return c.json({ error: upload.error }, upload.status);

  const quota = await checkPhotoQuota(c.env.PHOTOS_BUCKET, session.user.id, upload.bytes.byteLength);
  if (!quota.ok) return c.json({ error: quota.error }, 403);

  const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
  const key = `photos/${session.user.id}/${crypto.randomUUID()}.${ext}`;

  await c.env.PHOTOS_BUCKET.put(key, upload.bytes, {
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
  const userId = session.user.id;
  const db = getDb(c.env);

  if (photoUri && !isUserPhotoUrl(photoUri, c.env.R2_PUBLIC_URL, userId)
      && !(await isStoredPhotoUrl(db, userId, timestamp, photoUri))) {
    return c.json({ error: "Invalid photoUri" }, 400);
  }

  const saved = await saveCheckIn(db, { userId, branchCode, timestamp, note: note ?? "", photoUri: photoUri ?? null });
  if (!saved) return c.json({ error: "Invalid timestamp" }, 400);
  if (saved.duplicateOf) {
    // Another check-in already holds this branch and day. Tell the client
    // which one, so it doesn't treat this one as saved.
    return c.json({ ok: true, duplicateOf: saved.duplicateOf });
  }
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
  const timestamp = decodeURIComponent(c.req.param("timestamp"));
  if (photoUri && !isUserPhotoUrl(photoUri, c.env.R2_PUBLIC_URL, session.user.id)
      && !(await isStoredPhotoUrl(getDb(c.env), session.user.id, timestamp, photoUri))) {
    return c.json({ error: "Invalid photoUri" }, 400);
  }

  const result = await getDb(c.env)
    .updateTable("check_ins")
    .set({ photo_url: photoUri })
    .where("user_id", "=", session.user.id)
    .where("timestamp", "=", timestamp)
    .executeTakeFirst();
  // No matching check-in (e.g. its POST hasn't landed): say so, so the app
  // doesn't treat the photo as attached and pushes it again on the next sync.
  if (Number(result.numUpdatedRows) === 0) return c.json({ error: "Check-in not found" }, 404);
  return c.json({ ok: true });
});

app.get("/", (c) => c.text("tpl-passport-auth ok"));

export default app;
