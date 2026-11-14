// Pure helpers for request validation. Kept free of Worker bindings so they
// can be unit tested.

// The passport is for Toronto Public Library branches, and the app counts
// "one check-in per branch per day" in Toronto time. The server must use the
// same day, not the UTC date: after 7pm EST (8pm EDT) the UTC date is already
// tomorrow, which would merge an evening visit with the next day's.
const TORONTO_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// "YYYY-MM-DD" in Toronto time, or null for an unparseable timestamp.
export function torontoDayKey(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return TORONTO_DAY.format(date);
}

// ISO bounds wide enough to contain every timestamp on the same Toronto day
// as `timestamp` (a Toronto day is at most 25 hours long). Callers still
// filter the rows with torontoDayKey.
export function sameDaySearchWindow(timestamp: string): { from: string; to: string } {
  const ms = new Date(timestamp).getTime();
  const DAY = 24 * 60 * 60 * 1000;
  return { from: new Date(ms - 2 * DAY).toISOString(), to: new Date(ms + 2 * DAY).toISOString() };
}

// True when `uri` points inside the public photos bucket. Compares the parsed
// origin and path, so look-alike hosts such as
// https://photos.example.com.evil.com/ are rejected.
export function isOwnPhotoUrl(uri: string, publicBase: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(uri);
    base = new URL(publicBase);
  } catch {
    return false;
  }
  if (url.origin !== base.origin) return false;
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return url.pathname.startsWith(basePath) && url.pathname.length > basePath.length;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// Upload size check. The Content-Length header is required: without it the
// body could be any size. Browsers always send it for a Blob body.
export function checkUploadLength(header: string | undefined):
  | { ok: true }
  | { ok: false; status: 411 | 413 | 400; error: string } {
  if (header === undefined || header === "") {
    return { ok: false, status: 411, error: "Content-Length required" };
  }
  const length = Number(header);
  if (!Number.isInteger(length) || length <= 0) {
    return { ok: false, status: 400, error: "Invalid Content-Length" };
  }
  if (length > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, error: "File too large (max 10 MB)" };
  }
  return { ok: true };
}
