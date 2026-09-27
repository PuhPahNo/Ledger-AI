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

describe('parseAutomationSettings', () => {
  it('defaults to 2 corrections and 0.9 external confidence', async () => {
    const { parseAutomationSettings } = await import('./appSettings.js');
    expect(parseAutomationSettings({})).toEqual({ autoLearnMinCorrections: 2, externalSignalAutoApplyConfidence: 0.9 });
  });

  it('accepts in-range values and rejects corrupt or out-of-range ones', async () => {
    const { parseAutomationSettings } = await import('./appSettings.js');
    expect(parseAutomationSettings({ autoLearnMinCorrections: '3', externalSignalAutoApplyConfidence: '0.95' }))
      .toEqual({ autoLearnMinCorrections: 3, externalSignalAutoApplyConfidence: 0.95 });
    expect(parseAutomationSettings({ autoLearnMinCorrections: '0', externalSignalAutoApplyConfidence: 'x' }))
      .toEqual({ autoLearnMinCorrections: 2, externalSignalAutoApplyConfidence: 0.9 });
    expect(parseAutomationSettings({ autoLearnMinCorrections: '2.5', externalSignalAutoApplyConfidence: '1.5' }))
      .toEqual({ autoLearnMinCorrections: 2, externalSignalAutoApplyConfidence: 0.9 });
  });
});
