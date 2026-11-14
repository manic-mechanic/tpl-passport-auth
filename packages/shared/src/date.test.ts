import { describe, expect, it } from 'vitest'
import { checkInDayKey, dayRangeUtc, localDayKey } from './date'

describe('checkInDayKey', () => {
  it('uses the Toronto day, not UTC or the device zone', () => {
    // 8pm EST on Nov 14 is 01:00 UTC on Nov 15.
    expect(checkInDayKey('2026-11-15T01:00:00.000Z')).toBe('2026-11-14')
    expect(checkInDayKey('2026-11-15T15:00:00.000Z')).toBe('2026-11-15')
    // 8:30pm EDT on Jul 1 is 00:30 UTC on Jul 2.
    expect(checkInDayKey('2026-07-02T00:30:00.000Z')).toBe('2026-07-01')
    expect(checkInDayKey('2026-07-02T04:30:00.000Z')).toBe('2026-07-02')
  })

  it('returns an empty string for an invalid date', () => {
    expect(checkInDayKey('nope')).toBe('')
    expect(localDayKey('nope', 'UTC')).toBe('')
  })
})

describe('dayRangeUtc', () => {
  it('gives the UTC bounds of a Toronto day in standard time', () => {
    expect(dayRangeUtc('2026-11-14')).toEqual({ start: '2026-11-14T05:00:00.000Z', end: '2026-11-15T05:00:00.000Z' })
  })

  it('gives the UTC bounds in daylight time', () => {
    expect(dayRangeUtc('2026-07-01')).toEqual({ start: '2026-07-01T04:00:00.000Z', end: '2026-07-02T04:00:00.000Z' })
  })

  it('handles 23- and 25-hour days at DST changes', () => {
    // Spring forward: Mar 8 2026 is 23 hours long.
    expect(dayRangeUtc('2026-03-08')).toEqual({ start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' })
    // Fall back: Nov 1 2026 is 25 hours long.
    expect(dayRangeUtc('2026-11-01')).toEqual({ start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z' })
  })

  it('rolls over month and year ends', () => {
    expect(dayRangeUtc('2026-12-31')).toEqual({ start: '2026-12-31T05:00:00.000Z', end: '2027-01-01T05:00:00.000Z' })
  })

  it('agrees with checkInDayKey at the edges', () => {
    const { start, end } = dayRangeUtc('2026-11-01')!
    expect(checkInDayKey(start)).toBe('2026-11-01')
    expect(checkInDayKey(new Date(Date.parse(end) - 1))).toBe('2026-11-01')
    expect(checkInDayKey(end)).toBe('2026-11-02')
  })

  it('rejects malformed keys', () => {
    expect(dayRangeUtc('2026-11')).toBeNull()
  })
})
