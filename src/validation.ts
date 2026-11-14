// Pure helpers for request validation. Kept free of Worker bindings so they
// can be unit tested.

// Check-in timestamps must be canonical ISO UTC strings, exactly what the app
// sends (Date#toISOString()). The same-day check range-compares stored
// timestamps as strings, which is only correct when they all share this form.
// The year bounds keep later date arithmetic away from the Date limits.
export function isCanonicalCheckInTimestamp(timestamp: string): boolean {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return false;
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) return false;
  return date.toISOString() === timestamp;
}

// True when `uri` is a photo uploaded by `userId`: inside the public bucket
// (parsed origin and path, so look-alike hosts are rejected) and under that
// user's photos/<userId>/ key prefix, which /api/upload/photo always uses.
export function isUserPhotoUrl(uri: string, publicBase: string, userId: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(uri);
    base = new URL(publicBase);
  } catch {
    return false;
  }
  if (url.origin !== base.origin || url.search || url.hash) return false;
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const userPrefix = `${basePath}photos/${encodeURIComponent(userId)}/`;
  return url.pathname.startsWith(userPrefix) && url.pathname.length > userPrefix.length;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export type ReadBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 400 | 413; error: string };

// Reads an upload body, stopping as soon as it exceeds `limit` bytes. Doesn't
// rely on Content-Length, so chunked uploads are limited too; a declared
// length over the limit is rejected before reading anything.
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | undefined,
  limit: number = MAX_UPLOAD_BYTES,
): Promise<ReadBodyResult> {
  const tooLarge = { ok: false, status: 413, error: `File too large (max ${limit / (1024 * 1024)} MB)` } as const;
  if (contentLength && Number(contentLength) > limit) return tooLarge;
  if (!body) return { ok: false, status: 400, error: "Empty body" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return tooLarge;
    }
    chunks.push(value);
  }
  if (total === 0) return { ok: false, status: 400, error: "Empty body" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
