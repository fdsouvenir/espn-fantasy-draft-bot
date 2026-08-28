const HARD_CONCERN = /\b(?:questionable|doubtful|out|pup|not cleared|no-contact)\b/i;
const PRACTICE_CONCERN = /\b(?:limited|missed|absence|rehab|exit|left practice|did not return)\b/i;
const INJURY_MENTION = /\b(?:injured?|injury|shoulder|ankle|hamstring|knee|concussion)\b/i;
const CURRENTLY_CLEAR = /\b(?:healthy|cleared|full participant|practicing in full|returned to full practice|without (?:a )?(?:reported )?(?:limitation|restriction)|no (?:current |reported )?(?:injury|availability|limitation|restriction) concern|not listed on (?:the )?injury report)\b/i;

export function hasInjuryConcern(value) {
  const copy = String(value ?? "").trim();
  if (!copy) return false;
  if (HARD_CONCERN.test(copy)) return true;
  if (!PRACTICE_CONCERN.test(copy) && !INJURY_MENTION.test(copy)) return false;
  return !CURRENTLY_CLEAR.test(copy);
}
