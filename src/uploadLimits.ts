// Limits on photo uploads, so one account (or a stolen session) can't fill
// the R2 bucket. The app compresses photos to roughly 100-500 KB and uploads
// one per check-in, so these leave plenty of room for real use:
//
// - a rate limit per user (Workers Rate Limiting binding, see wrangler.toml):
//   20 uploads a minute. Signing in uploads every photo that's only on the
//   device, one at a time, so a large backlog can hit it; the app keeps those
//   photos and uploads the rest on its next sync.
// - a storage quota per user, counted from what's already in R2 under
//   photos/<userId>/: 300 photos and 300 MB. With 100 branches and one
//   photo per check-in, that's several visits' worth of photos per branch.

export const MAX_PHOTOS_PER_USER = 300;
export const MAX_PHOTO_BYTES_PER_USER = 300 * 1024 * 1024;

export type PhotoQuotaResult =
  | { ok: true; count: number; bytes: number }
  | { ok: false; count: number; bytes: number; error: string };

// Counts the user's stored photos and checks that one more of `incomingBytes`
// fits. Two uploads at the same moment can both pass, which only lets a user
// go one photo over; that's fine for a quota meant to stop abuse.
export async function checkPhotoQuota(
  bucket: Pick<R2Bucket, "list">,
  userId: string,
  incomingBytes: number,
  limits = { photos: MAX_PHOTOS_PER_USER, bytes: MAX_PHOTO_BYTES_PER_USER },
): Promise<PhotoQuotaResult> {
  let count = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `photos/${userId}/`, limit: 1000, cursor });
    for (const object of page.objects) {
      count++;
      bytes += object.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
    // No need to keep counting once the quota is already exceeded.
    if (count >= limits.photos || bytes >= limits.bytes) break;
  } while (cursor);

  if (count + 1 > limits.photos) {
    return { ok: false, count, bytes, error: `Photo limit reached (${limits.photos} photos)` };
  }
  if (bytes + incomingBytes > limits.bytes) {
    return { ok: false, count, bytes, error: `Photo storage limit reached (${limits.bytes / (1024 * 1024)} MB)` };
  }
  return { ok: true, count, bytes };
}
