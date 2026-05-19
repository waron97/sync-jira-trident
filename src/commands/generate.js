import { fetchJiraIssue } from "../util/jira.js";
import { fetchExistingTasks, fetchClusters, createTridentTask, writeTridentTask } from "../util/trident.js";
import { normalizeIssue, buildTridentPayload } from "./run.js";

export async function generateCommand(key) {
  const raw = await fetchJiraIssue(key);
  const issue = normalizeIssue(raw);

  const [clusters, existingTasks] = await Promise.all([fetchClusters(), fetchExistingTasks()]);
  const existingNames = new Set(existingTasks.map((t) => t.name));
  const payload = buildTridentPayload(issue, clusters);

  if (existingNames.has(payload.name)) {
    console.log(`Task already exists: ${payload.name}`);
    return;
  }

  const id = await createTridentTask(payload);
  await writeTridentTask(id, { x_tech_ownership_id: payload.x_tech_ownership_id });
  console.log(`Created Trident task ${id}: ${payload.name}`);
}
