import { matchCluster } from "./trident.js";
import { normalizeName, fuzzyMatchName, normalizeSprintText } from "./matching.js";
import { resolveAssigneeLLM, resolveClusterLLM, meetsConfidence, meetsAssigneeConfidence } from "./claude.js";

export const TAG_MAP = {
  Bug: { id: 21, name: "BUG" },
  "Bug UX/UI": { id: 21, name: "BUG" },
  Enhancement: { id: 251, name: "Enhancement" },
  Verifica: { id: 70, name: "VERIFICA" },
};

const MONTHS_IT = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function stripRankPrefix(raw) {
  return (raw ?? "").replace(/^\s*\d+(\.\d+)?\.\s*/, "").trim();
}

export function parsePriorityWeek(raw) {
  const text = stripRankPrefix(raw).toLowerCase();
  const year = new Date().getFullYear();

  let m = text.match(/^(\d+)\s+([a-zà-ú]+)\s*-\s*(\d+)\s+([a-zà-ú]+)$/i);
  if (m) {
    const [, dayFrom, monthFrom, dayTo, monthTo] = m;
    const mFrom = MONTHS_IT.indexOf(monthFrom);
    const mTo = MONTHS_IT.indexOf(monthTo);
    if (mFrom === -1 || mTo === -1) return null;
    return {
      derivedName: `${dayFrom} ${capitalize(monthFrom)} a ${dayTo} ${capitalize(monthTo)} | ${year}`,
      dateFrom: `${year}-${String(mFrom + 1).padStart(2, "0")}-${String(dayFrom).padStart(2, "0")}`,
      dateTo: `${year}-${String(mTo + 1).padStart(2, "0")}-${String(dayTo).padStart(2, "0")}`,
    };
  }

  m = text.match(/^(\d+)\s*-\s*(\d+)\s+([a-zà-ú]+)$/i);
  if (m) {
    const [, dayFrom, dayTo, month] = m;
    const mi = MONTHS_IT.indexOf(month);
    if (mi === -1) return null;
    return {
      derivedName: `${dayFrom} a ${dayTo} | ${capitalize(month)} ${year}`,
      dateFrom: `${year}-${String(mi + 1).padStart(2, "0")}-${String(dayFrom).padStart(2, "0")}`,
      dateTo: `${year}-${String(mi + 1).padStart(2, "0")}-${String(dayTo).padStart(2, "0")}`,
    };
  }

  return null;
}

// Text-match only — does not create anything. Caller decides whether/how
// to create a missing sprint (report.js simulates it, run.js actually does).
export function matchSprint(priorityWeek, sprints) {
  if (!priorityWeek) return { applicable: false };

  const target = normalizeSprintText(priorityWeek);
  const matches = sprints
    .filter((s) => normalizeSprintText(s.x_name) === target)
    .sort((a, b) => a.id - b.id);

  if (matches.length) {
    return {
      applicable: true,
      matchedSprintId: matches[0].id,
      matchedSprintName: matches[0].x_name,
      duplicateIds: matches.length > 1 ? matches.map((s) => s.id) : undefined,
    };
  }

  return {
    applicable: true,
    matchedSprintId: null,
    wouldCreate: true,
    derived: parsePriorityWeek(priorityWeek),
  };
}

export async function resolveAssignee(rawAssignee, allowlist) {
  if (!rawAssignee) return { method: "unresolved", tridentUserId: null };

  const target = normalizeName(rawAssignee);
  const exact = allowlist.find((u) => normalizeName(u.name) === target || normalizeName(u.login) === target);
  if (exact) return { method: "exact", tridentUserId: exact.id, matchedName: exact.name };

  const fuzzy = fuzzyMatchName(rawAssignee, allowlist);
  if (fuzzy) return { method: "fuzzy", tridentUserId: fuzzy.candidate.id, matchedName: fuzzy.candidate.name, score: fuzzy.score };

  const llm = await resolveAssigneeLLM(rawAssignee, allowlist.map((u) => u.name));
  if (meetsAssigneeConfidence(llm)) {
    const matched = allowlist.find((u) => u.name === llm.match);
    if (matched) return { method: "llm", tridentUserId: matched.id, matchedName: matched.name, confidence: llm.confidence };
  }

  return { method: "unresolved", tridentUserId: null };
}

export async function resolveCluster(issue, clusters) {
  const stringMatchId = matchCluster(clusters, issue.processoDiRiferimento);
  if (stringMatchId !== false) {
    const cluster = clusters.find((c) => c.id === stringMatchId);
    return { method: "string-match", clusterId: stringMatchId, clusterName: cluster?.x_name };
  }

  if (!issue.processoDiRiferimento) return { method: "none", clusterId: false };

  const llm = await resolveClusterLLM(issue.title, issue.processoDiRiferimento, clusters.map((c) => c.x_name));
  if (meetsConfidence(llm)) {
    const matched = clusters.find((c) => c.x_name === llm.match);
    if (matched) return { method: "llm", clusterId: matched.id, clusterName: matched.x_name, confidence: llm.confidence };
  }

  return { method: "none", clusterId: false };
}

// Only meaningful for tickets that already passed the assignee gate — the
// resolved assignee is always the fallback, no PM/default catch-all.
export function resolveOwnership(clusterResult, clusters, assigneeResult) {
  if (clusterResult.clusterId !== false) {
    const cluster = clusters.find((c) => c.id === clusterResult.clusterId);
    const ownerId = Array.isArray(cluster?.x_owner_id) ? cluster.x_owner_id[0] : cluster?.x_owner_id;
    if (ownerId) return { source: "cluster-owner", tridentUserId: ownerId };
  }

  return { source: "assignee", tridentUserId: assigneeResult.tridentUserId };
}

export function resolveTag(tipologiaSegnalazione) {
  return TAG_MAP[tipologiaSegnalazione] ?? null;
}
