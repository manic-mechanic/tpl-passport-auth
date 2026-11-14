import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, isCanonicalCheckInTimestamp, isUserPhotoUrl, readBodyWithLimit } from "../src/validation";

describe("isCanonicalCheckInTimestamp", () => {
  it("accepts what Date#toISOString produces", () => {
    expect(isCanonicalCheckInTimestamp(new Date("2026-11-14T20:00:00Z").toISOString())).toBe(true);
    expect(isCanonicalCheckInTimestamp("2026-11-15T01:00:00.000Z")).toBe(true);
  });

  it("rejects other date formats", () => {
    expect(isCanonicalCheckInTimestamp("Nov 14 2026 20:00 GMT-0500")).toBe(false);
    expect(isCanonicalCheckInTimestamp("2026-11-14T20:00:00Z")).toBe(false);
    expect(isCanonicalCheckInTimestamp("2026-11-14T15:00:00.000-05:00")).toBe(false);
    expect(isCanonicalCheckInTimestamp("2026-11-14")).toBe(false);
    expect(isCanonicalCheckInTimestamp("not a date")).toBe(false);
  });

  it("rejects years outside 2000-2100", () => {
    expect(isCanonicalCheckInTimestamp("+275760-09-12T00:00:00.000Z")).toBe(false);
    expect(isCanonicalCheckInTimestamp("1999-12-31T23:59:59.999Z")).toBe(false);
  });
});

describe("isUserPhotoUrl", () => {
  const base = "https://photos.librarypassport.ca";

  it("accepts the user's own uploads", () => {
    expect(isUserPhotoUrl(`${base}/photos/u1/a.jpg`, base, "u1")).toBe(true);
    expect(isUserPhotoUrl(`${base}/photos/u1/a.jpg`, `${base}/`, "u1")).toBe(true);
  });

  it("rejects another user's uploads", () => {
    expect(isUserPhotoUrl(`${base}/photos/u2/a.jpg`, base, "u1")).toBe(false);
    expect(isUserPhotoUrl(`${base}/photos/u1x/a.jpg`, base, "u1")).toBe(false);
    expect(isUserPhotoUrl(`${base}/photos/u1/`, base, "u1")).toBe(false);
  });

  it("rejects look-alike hosts, other origins and path tricks", () => {
    expect(isUserPhotoUrl("https://photos.librarypassport.ca.evil.com/photos/u1/a.jpg", base, "u1")).toBe(false);
    expect(isUserPhotoUrl("https://photos.librarypassport.ca@evil.com/photos/u1/a.jpg", base, "u1")).toBe(false);
    expect(isUserPhotoUrl("http://photos.librarypassport.ca/photos/u1/a.jpg", base, "u1")).toBe(false);
    expect(isUserPhotoUrl(`${base}/photos/u1/../u2/a.jpg`, base, "u1")).toBe(false);
    expect(isUserPhotoUrl(`${base}/photos/u1/a.jpg?x=1`, base, "u1")).toBe(false);
  });

  it("respects a path in the public base", () => {
    const r2 = "https://pub-abc.r2.dev/bucket";
    expect(isUserPhotoUrl("https://pub-abc.r2.dev/bucket/photos/u1/a.jpg", r2, "u1")).toBe(true);
    expect(isUserPhotoUrl("https://pub-abc.r2.dev/bucket-other/photos/u1/a.jpg", r2, "u1")).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(isUserPhotoUrl("not a url", base, "u1")).toBe(false);
    expect(isUserPhotoUrl(`${base}/photos/u1/a.jpg`, "", "u1")).toBe(false);
  });
});

describe("readBodyWithLimit", () => {
  function stream(...chunks: number[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const size of chunks) controller.enqueue(new Uint8Array(size));
        controller.close();
      },
    });
  }

  it("reads a body without Content-Length (chunked upload)", async () => {
    const result = await readBodyWithLimit(stream(3, 4), undefined, 10);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.bytes.byteLength).toBe(7);
  });

  it("stops reading once the limit is exceeded, with or without the header", async () => {
    expect(await readBodyWithLimit(stream(6, 6), undefined, 10)).toMatchObject({ ok: false, status: 413 });
    expect(await readBodyWithLimit(stream(6, 6), "5", 10)).toMatchObject({ ok: false, status: 413 });
  });

  it("rejects a declared length over the limit before reading", async () => {
    expect(await readBodyWithLimit(stream(1), String(MAX_UPLOAD_BYTES + 1))).toMatchObject({ ok: false, status: 413 });
  });

  it("accepts exactly the limit", async () => {
    expect(await readBodyWithLimit(stream(10), "10", 10)).toMatchObject({ ok: true });
  });

  it("rejects an empty body", async () => {
    expect(await readBodyWithLimit(null, undefined)).toMatchObject({ ok: false, status: 400 });
    expect(await readBodyWithLimit(stream(), undefined)).toMatchObject({ ok: false, status: 400 });
  });
});
