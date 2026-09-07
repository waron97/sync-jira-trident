import { fetchJiraIssue } from "../util/jira.js";
import { fetchExistingTasks, fetchClusters, fetchProjectFollowers, fetchSprints, createTridentTask, writeTridentTask } from "../util/trident.js";
import { resolveAssignee, resolveCluster, resolveOwnership, resolveTag } from "../util/resolve.js";
import { normalizeIssue, buildTridentPayload, buildTaskName, extractTaskKey, resolveOrCreateSprint, uploadIssueAttachments } from "./run.js";

export async function generateCommand(key) {
  const raw = await fetchJiraIssue(key);
  const issue = normalizeIssue(raw);

  const [clusters, allowlist, sprints, existingTasks] = await Promise.all([
    fetchClusters(),
    fetchProjectFollowers(),
    fetchSprints(),
    fetchExistingTasks(),
  ]);
  const existingKeys = new Set(existingTasks.map((t) => extractTaskKey(t.name)).filter(Boolean));

  const assignee = await resolveAssignee(issue.assignee, allowlist);
  if (assignee.method === "unresolved") {
    console.log(`Not creating ${key}: assignee "${issue.assignee}" doesn't match a Team JIRA Sorgenia project member`);
    return;
  }

  if (existingKeys.has(issue.key)) {
    console.log(`Task already exists: ${buildTaskName(issue)}`);
    return;
  }

  const cluster = await resolveCluster(issue, clusters);
  const ownership = resolveOwnership(cluster, clusters, assignee);
  const tag = resolveTag(issue.tipologiaSegnalazione);
  const sprintId = await resolveOrCreateSprint(issue.priorityWeek, sprints);

  const payload = buildTridentPayload(issue, { assignee, cluster, ownership, tag, sprintId });

  const id = await createTridentTask(payload);
  await writeTridentTask(id, { x_tech_ownership_id: payload.x_tech_ownership_id });
  console.log(`Created Trident task ${id}: ${payload.name}`);
  await uploadIssueAttachments(issue, id);
}
