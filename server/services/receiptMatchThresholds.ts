/**
 * Receipt ↔ transaction matching policy constants. Dependency-free so the matcher, the
 * category-evidence reviewer, and (mirrored + sync-tested) the UI all read the same bars.
 */

/** Match score at/above which a receipt is attached without asking. */
export const AUTO_ATTACH_THRESHOLD = 0.82;

/** Match score at/above which the best candidate is surfaced as a suggestion. */
export const SUGGESTED_THRESHOLD = 0.5;

/**
 * Minimum extraction confidence for the matcher to act on its own. Regex fallback extractions
 * (0.2–0.45) only ever produce suggestions — a misread total must not silently pair.
 */
export const MIN_EXTRACTION_CONFIDENCE_FOR_AUTO_ATTACH = 0.6;
