import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  checkUploadLength,
  isOwnPhotoUrl,
  sameDaySearchWindow,
  torontoDayKey,
} from "../src/validation";

describe("torontoDayKey", () => {
  it("uses the Toronto date, not the UTC date, in the evening", () => {
    // 8pm EST on Nov 14 is 01:00 UTC on Nov 15.
    expect(torontoDayKey("2026-11-15T01:00:00.000Z")).toBe("2026-11-14");
    // 10am EST on Nov 15.
    expect(torontoDayKey("2026-11-15T15:00:00.000Z")).toBe("2026-11-15");
  });

  it("handles daylight saving time", () => {
    // 8:30pm EDT on Jul 1 is 00:30 UTC on Jul 2.
    expect(torontoDayKey("2026-07-02T00:30:00.000Z")).toBe("2026-07-01");
    // 11:30pm EDT on Jul 1 is 03:30 UTC on Jul 2.
    expect(torontoDayKey("2026-07-02T03:30:00.000Z")).toBe("2026-07-01");
    // 12:30am EDT on Jul 2.
    expect(torontoDayKey("2026-07-02T04:30:00.000Z")).toBe("2026-07-02");
  });

  it("returns null for an invalid timestamp", () => {
    expect(torontoDayKey("not a date")).toBeNull();
  });
});

describe("sameDaySearchWindow", () => {
  it("contains the whole Toronto day around the timestamp", () => {
    const { from, to } = sameDaySearchWindow("2026-11-15T01:00:00.000Z");
    // Start and end of Nov 14 in Toronto (EST, UTC-5).
    expect(from <= "2026-11-14T05:00:00.000Z").toBe(true);
    expect(to >= "2026-11-15T04:59:59.999Z").toBe(true);
  });
});

describe("isOwnPhotoUrl", () => {
  const base = "https://photos.librarypassport.ca";

  it("accepts URLs in the bucket", () => {
    expect(isOwnPhotoUrl(`${base}/photos/u1/a.jpg`, base)).toBe(true);
    expect(isOwnPhotoUrl(`${base}/photos/u1/a.jpg`, `${base}/`)).toBe(true);
  });

  it("rejects look-alike hosts and other origins", () => {
    expect(isOwnPhotoUrl("https://photos.librarypassport.ca.evil.com/a.jpg", base)).toBe(false);
    expect(isOwnPhotoUrl("https://photos.librarypassport.ca@evil.com/a.jpg", base)).toBe(false);
    expect(isOwnPhotoUrl("http://photos.librarypassport.ca/a.jpg", base)).toBe(false);
    expect(isOwnPhotoUrl("https://evil.com/a.jpg", base)).toBe(false);
  });

  it("respects a path in the public base", () => {
    const r2 = "https://pub-abc.r2.dev/bucket";
    expect(isOwnPhotoUrl("https://pub-abc.r2.dev/bucket/photos/a.jpg", r2)).toBe(true);
    expect(isOwnPhotoUrl("https://pub-abc.r2.dev/bucket-other/a.jpg", r2)).toBe(false);
    expect(isOwnPhotoUrl("https://pub-abc.r2.dev/bucket/", r2)).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(isOwnPhotoUrl("not a url", base)).toBe(false);
    expect(isOwnPhotoUrl(`${base}/a.jpg`, "")).toBe(false);
  });
});

describe("checkUploadLength", () => {
  it("requires Content-Length", () => {
    expect(checkUploadLength(undefined)).toMatchObject({ ok: false, status: 411 });
    expect(checkUploadLength("")).toMatchObject({ ok: false, status: 411 });
  });

  it("rejects invalid, empty and oversized bodies", () => {
    expect(checkUploadLength("abc")).toMatchObject({ ok: false, status: 400 });
    expect(checkUploadLength("0")).toMatchObject({ ok: false, status: 400 });
    expect(checkUploadLength(String(MAX_UPLOAD_BYTES + 1))).toMatchObject({ ok: false, status: 413 });
  });

  it("accepts sizes up to the limit", () => {
    expect(checkUploadLength("1024")).toEqual({ ok: true });
    expect(checkUploadLength(String(MAX_UPLOAD_BYTES))).toEqual({ ok: true });
  });
});
