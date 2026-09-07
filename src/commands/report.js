import fs from "fs/promises";
import { fetchAllJiraIssues } from "../util/jira.js";
import { normalizeIssue, extractTaskKey } from "./run.js";
import { fetchClusters, fetchExistingTasks, fetchProjectFollowers, fetchSprints } from "../util/trident.js";
import { resolveAssignee, resolveCluster, resolveOwnership, resolveTag, matchSprint } from "../util/resolve.js";

export async function reportCommand(options) {
  const [rawIssues, clusters, allowlist, sprints, existingTasks] = await Promise.all([
    fetchAllJiraIssues(),
    fetchClusters(),
    fetchProjectFollowers(),
    fetchSprints(),
    fetchExistingTasks(),
  ]);

  const existingKeys = new Set(existingTasks.map((t) => extractTaskKey(t.name)).filter(Boolean));
  const issues = rawIssues.map(normalizeIssue);
  const entries = [];

  for (const issue of issues) {
    const assignee = await resolveAssignee(issue.assignee, allowlist);
    const skip = assignee.method === "unresolved";

    // Cluster/tag/sprint are still resolved even when skipping, purely so
    // the report shows what *would* have happened — useful for judging
    // whether the allowlist/mapping needs work, not because a skipped
    // ticket gets any of these written.
    const cluster = await resolveCluster(issue, clusters);
    const ownership = skip ? null : resolveOwnership(cluster, clusters, assignee);
    const tag = resolveTag(issue.tipologiaSegnalazione);
    const sprint = matchSprint(issue.priorityWeek, sprints);
    const alreadyExists = existingKeys.has(issue.key);

    entries.push({
      key: issue.key,
      title: issue.title,
      rawAssignee: issue.assignee,
      assignee,
      skip,
      cluster,
      ownership,
      tag,
      sprint,
      alreadyExists,
    });

    console.log(`${issue.key}: assignee=${assignee.method}${skip ? " (SKIP - no matching project member)" : ""} cluster=${cluster.method} sprint=${sprint.applicable ? (sprint.matchedSprintId ?? "would-create") : "n/a"}`);
  }

  const summary = {
    total: entries.length,
    skipped: entries.filter((e) => e.skip).length,
    alreadyExists: entries.filter((e) => !e.skip && e.alreadyExists).length,
    wouldCreate: entries.filter((e) => !e.skip && !e.alreadyExists).length,
    assignee: {
      exact: entries.filter((e) => e.assignee.method === "exact").length,
      fuzzy: entries.filter((e) => e.assignee.method === "fuzzy").length,
      llm: entries.filter((e) => e.assignee.method === "llm").length,
      unresolved: entries.filter((e) => e.assignee.method === "unresolved").length,
    },
    cluster: {
      stringMatch: entries.filter((e) => e.cluster.method === "string-match").length,
      llm: entries.filter((e) => e.cluster.method === "llm").length,
      none: entries.filter((e) => e.cluster.method === "none").length,
    },
    sprint: {
      applicable: entries.filter((e) => e.sprint.applicable).length,
      matched: entries.filter((e) => e.sprint.applicable && e.sprint.matchedSprintId).length,
      wouldCreate: entries.filter((e) => e.sprint.applicable && e.sprint.wouldCreate).length,
    },
  };

  const outPath = options.output ?? "report.json";
  await fs.writeFile(outPath, JSON.stringify({ summary, entries }, null, 2), "utf-8");

  console.log(`\nWrote ${entries.length} entries to ${outPath}`);
  console.log(JSON.stringify(summary, null, 2));
}
