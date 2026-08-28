const HARD_CONCERN = /\b(?:questionable|doubtful|out|pup|not cleared|no-contact)\b/i;
const PRACTICE_CONCERN = /\b(?:limited|missed|absence|rehab|exit|left practice|did not return)\b/i;
const CURRENTLY_CLEAR = /\b(?:healthy|cleared|full participant|practicing in full|returned to full practice|without (?:a )?(?:reported )?(?:limitation|restriction)|no (?:current |reported )?(?:injury|availability|limitation|restriction) concern|not listed on (?:the )?injury report)\b/i;
const EXPLICIT_INJURY_STATUSES = new Set([
  "QUESTIONABLE",
  "DOUBTFUL",
  "OUT",
  "IR",
  "PUP",
  "NFI",
  "SUSPENSION",
  "SUSPENDED",
]);

export function hasInjuryConcern(value, injuryStatus = "") {
  if (EXPLICIT_INJURY_STATUSES.has(String(injuryStatus).trim().toUpperCase())) return true;
  const copy = String(value ?? "").trim();
  if (!copy) return false;
  if (HARD_CONCERN.test(copy)) return true;
  return PRACTICE_CONCERN.test(copy) && !CURRENTLY_CLEAR.test(copy);
}
