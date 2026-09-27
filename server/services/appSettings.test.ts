import { describe, expect, it } from 'vitest';
import { parseDailyCounter, todayUtc } from './appSettings.js';

describe('parseDailyCounter', () => {
  const today = '2026-09-27';

  it('reads today\'s count, including the json_build_object format written by SQL', () => {
    expect(parseDailyCounter('{"date":"2026-09-27","calls":4}', today)).toEqual({ date: today, calls: 4 });
    expect(parseDailyCounter('{"date" : "2026-09-27", "calls" : 7}', today)).toEqual({ date: today, calls: 7 });
  });

  it('resets on a new day, a missing value, or corrupt JSON', () => {
    expect(parseDailyCounter('{"date":"2026-09-26","calls":40}', today)).toEqual({ date: today, calls: 0 });
    expect(parseDailyCounter(null, today)).toEqual({ date: today, calls: 0 });
    expect(parseDailyCounter('{oops', today)).toEqual({ date: today, calls: 0 });
  });

  it('keys days in UTC', () => {
    expect(todayUtc(new Date('2026-09-27T23:30:00Z'))).toBe('2026-09-27');
  });
});
