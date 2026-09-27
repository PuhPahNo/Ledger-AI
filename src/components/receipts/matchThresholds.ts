/**
 * Mirrors server/services/receiptMatchThresholds.ts (kept in sync by matchThresholds.test.ts)
 * so score badges agree with what the matcher actually does.
 */
export const AUTO_ATTACH_THRESHOLD = 0.82;
export const SUGGESTED_THRESHOLD = 0.5;

export function matchScoreTone(score: number): 'success' | 'warning' | 'muted' {
  if (score >= AUTO_ATTACH_THRESHOLD) return 'success';
  if (score >= SUGGESTED_THRESHOLD) return 'warning';
  return 'muted';
}
