// Limits on photo uploads, so one account (or a stolen session) can't fill
// the R2 bucket. The app compresses photos to roughly 100-500 KB and uploads
// one per check-in, so these leave plenty of room for real use:
//
// - a rate limit per user (Workers Rate Limiting binding, see wrangler.toml):
//   20 uploads a minute. Signing in uploads every photo that's only on the
//   device, one at a time; the app stops at the first 429 and uploads the
//   rest on its next sync.
// - a storage quota per user, counted from what's in R2 under
//   photos/<userId>/: 300 photos and 300 MB. With 100 branches and one
//   photo per check-in, that's several visits' worth of photos per branch.
//
// Nothing else deletes from the bucket, and replacing or retaking a photo
// uploads a new object, so a user's folder collects photos no check-in uses.
// When an upload would go over the quota, those are deleted first (if older
// than a day, so a photo uploaded but not yet attached to its check-in is
// kept, and only if every check-in's photo URL maps to a key, so nothing is
// deleted on a guess), and the quota is checked again. Only photos the user's check-ins
// actually use can fill it.

export const MAX_PHOTOS_PER_USER = 300;
export const MAX_PHOTO_BYTES_PER_USER = 300 * 1024 * 1024;
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

// Listing stops here; well past the quota, so it only bounds a user who got
// far over it some other way.
const MAX_LISTED = 5000;

type StoredPhoto = { key: string; size: number; uploaded: Date };

export type PhotoQuotaResult =
  | { ok: true; count: number; bytes: number; deleted: number }
  | { ok: false; count: number; bytes: number; deleted: number; error: string };

type Limits = { photos: number; bytes: number };

function verdict(photos: StoredPhoto[], incomingBytes: number, limits: Limits, deleted: number): PhotoQuotaResult {
  const count = photos.length;
  const bytes = photos.reduce((sum, p) => sum + p.size, 0);
  if (count + 1 > limits.photos) {
    return { ok: false, count, bytes, deleted, error: `Photo limit reached (${limits.photos} photos)` };
  }
  if (bytes + incomingBytes > limits.bytes) {
    return { ok: false, count, bytes, deleted, error: `Photo storage limit reached (${limits.bytes / (1024 * 1024)} MB)` };
  }
  return { ok: true, count, bytes, deleted };
}

async function listUserPhotos(bucket: Pick<R2Bucket, "list">, userId: string): Promise<StoredPhoto[]> {
  const photos: StoredPhoto[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `photos/${userId}/`, limit: 1000, cursor });
    for (const o of page.objects) photos.push({ key: o.key, size: o.size, uploaded: o.uploaded });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && photos.length < MAX_LISTED);
  return photos;
}

// Checks that one more photo of `incomingBytes` fits the user's quota,
// deleting photos no check-in uses first if it wouldn't. `referencedKeys`
// is only called when the quota is reached.
//
// Concurrent uploads each list the folder before any of them stores, so a
// burst can overshoot the quota by up to the rate limit (20); that's fine
// for a limit meant to stop abuse, not to account exactly.
export async function enforcePhotoQuota(opts: {
  bucket: Pick<R2Bucket, "list" | "delete">;
  userId: string;
  incomingBytes: number;
  // The R2 keys the user's check-ins point at, and how many of their photo
  // URLs couldn't be matched to a key. Any unmatched URL means we can't be
  // sure what's in use, so nothing is deleted.
  referencedKeys: () => Promise<{ keys: Set<string>; unmatched: number }>;
  now?: Date;
  limits?: Limits;
}): Promise<PhotoQuotaResult> {
  const limits = opts.limits ?? { photos: MAX_PHOTOS_PER_USER, bytes: MAX_PHOTO_BYTES_PER_USER };
  const now = (opts.now ?? new Date()).getTime();

  const photos = await listUserPhotos(opts.bucket, opts.userId);
  const first = verdict(photos, opts.incomingBytes, limits, 0);
  if (first.ok) return first;

  const referenced = await opts.referencedKeys();
  if (referenced.unmatched > 0) return first;
  const orphans = photos.filter(p => !referenced.keys.has(p.key) && now - p.uploaded.getTime() > ORPHAN_GRACE_MS);
  for (let i = 0; i < orphans.length; i += 1000) {
    await opts.bucket.delete(orphans.slice(i, i + 1000).map(p => p.key));
  }
  const orphanKeys = new Set(orphans.map(p => p.key));
  return verdict(photos.filter(p => !orphanKeys.has(p.key)), opts.incomingBytes, limits, orphans.length);
}

// The R2 key a stored photo URL points at, or null if it isn't one of this
// user's uploads. Matches the photos/<userId>/ part of the path whatever the
// host or base path, since check-ins saved under an earlier R2_PUBLIC_URL
// (e.g. the default r2.dev address) point at the same keys. Uploads have
// always used photos/<userId>/<uuid>.<ext>.
export function photoKeyFromUrl(url: string, userId: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const at = path.indexOf(`/photos/${userId}/`);
  return at === -1 ? null : path.slice(at + 1);
}
