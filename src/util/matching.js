export function normalizeName(str) {
  return (str ?? "")
    .toLowerCase()
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }

  return dp[a.length][b.length];
}

function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

const FUZZY_THRESHOLD = 0.8;

export function fuzzyMatchName(rawName, candidates) {
  const target = normalizeName(rawName);
  if (!target) return null;

  let best = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const score = similarity(target, normalizeName(candidate.name));
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (!best || bestScore < FUZZY_THRESHOLD) return null;
  return { candidate: best, score: bestScore };
}

const MONTHS = "gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre";

export function normalizeSprintText(str) {
  return (str ?? "")
    .toLowerCase()
    .replace(/^\s*\d+(\.\d+)?\.\s*/, "") // strip leading rank prefix, e.g. "10.0. "
    .replace(/\|/g, " ")
    .replace(/\b\d{4}\b/g, "") // strip year
    .replace(new RegExp(`\\b(${MONTHS})\\b`, "g"), (m) => m) // months kept, just normalizes case via outer lowercase
    .replace(/\ba\b/g, "-") // unify "a" separator with "-"
    .replace(/-+/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
