import fs from "fs/promises";
import { fetchAllJiraIssues, adfToHtml } from "../util/jira.js";
import { fetchExistingTasks, fetchClusters, matchCluster, createTridentTask, writeTridentTask } from "../util/trident.js";

function resolveSeverity(issue) {
  if (issue.bloccante === "Si") return parseInt(process.env.TRIDENT_SEVERITY_BLOCCANTE);
  switch (issue.priority) {
    case "Highest":
    case "High":   return parseInt(process.env.TRIDENT_SEVERITY_HIGH);
    case "Low":
    case "Lowest": return parseInt(process.env.TRIDENT_SEVERITY_LOW);
    default:       return parseInt(process.env.TRIDENT_SEVERITY_MEDIUM);
  }
}

export function normalizeIssue(raw) {
  return {
    key: raw.key,
    title: raw.fields.summary,
    description: adfToHtml(raw.fields.description),
    assignee: raw.fields.assignee?.displayName ?? null,
    status: raw.fields.status?.name ?? null,
    priority: raw.fields.priority?.name ?? null,
    processoDiRiferimento: raw.fields.customfield_10460?.value ?? null,
    bloccante: raw.fields.customfield_10222?.value ?? null,
    reporter: raw.fields.reporter?.displayName ?? null,
    modalitaDiEsecuzione: raw.fields.customfield_10251?.value ?? raw.fields.customfield_10251 ?? null,
    tipologiaSegnalazione: raw.fields.customfield_10312?.value ?? raw.fields.customfield_10312 ?? null,
  };
}

export function buildTridentPayload(issue, clusters) {
  const JIRA_BROWSE = process.env.JIRA_URL.replace("/rest/api/3", "");
  const ASSIGNEE_MAP = {
    "Aron Winkler":     parseInt(process.env.TRIDENT_ID_ARON),
    "Selene Verna":     parseInt(process.env.TRIDENT_ID_SELENE),
    "Giovanni Corrado": parseInt(process.env.TRIDENT_ID_GIOVANNI),
    "Licia Matarrese":  parseInt(process.env.TRIDENT_ID_LICIA),
  };
  const OWNER_MAP = {
    "Licia Matarrese": parseInt(process.env.TRIDENT_ID_LICIA),
  };
  const clusterId = matchCluster(clusters, issue.processoDiRiferimento);
  const assigneeId = ASSIGNEE_MAP[issue.assignee] ?? parseInt(process.env.TRIDENT_ID_GIOVANNI);
  const ownerId = OWNER_MAP[issue.assignee] ?? parseInt(process.env.TRIDENT_ID_GIOVANNI);
  return {
    name: `[${issue.key}] ${issue.title}`,
    project_id: parseInt(process.env.TRIDENT_PROJECT_ID),
    stage_id: parseInt(process.env.TRIDENT_STARTING_STAGE_ID),
    x_livello_task: "task",
    x_severity_id: resolveSeverity(issue),
    x_tech_ownership_id: ownerId,
    x_cluster_id: clusterId,
    user_ids: [[6, 0, [assigneeId]]],
    description: `<p>Link Jira: <a href="${JIRA_BROWSE}/browse/${issue.key}">${issue.key}</a></p><p>Processo di riferimento: ${issue.processoDiRiferimento ?? ""}</p><p>Richiedente: ${issue.reporter ?? ""}</p><p>Modalità di esecuzione: ${issue.modalitaDiEsecuzione ?? ""}</p><p>Tipologia segnalazione: ${issue.tipologiaSegnalazione ?? ""}</p>${issue.description}`,
  };
}

export async function runCommand(options) {
  const issues = await fetchAllJiraIssues();

  const output = issues.map(normalizeIssue);

  const clusters = await fetchClusters();

  const tridentPayloads = output.map((issue) => buildTridentPayload(issue, clusters));

  const outPath = options.output ?? "output.json";
  await fs.writeFile(outPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Wrote ${output.length} issues to ${outPath}`);

  await fs.writeFile("trident.json", JSON.stringify(tridentPayloads, null, 2), "utf-8");
  console.log(`Wrote ${tridentPayloads.length} Trident payloads to trident.json`);

  const existingTasks = await fetchExistingTasks();
  const existingByName = new Map(existingTasks.map((t) => [t.name, t]));

  const toCreate = tridentPayloads.filter((p) => !existingByName.has(p.name));
  console.log(`${toCreate.length} new tasks to create (${tridentPayloads.length - toCreate.length} already exist)`);

  for (const payload of toCreate) {
    const id = await createTridentTask(payload);
    await writeTridentTask(id, { x_tech_ownership_id: payload.x_tech_ownership_id });
    console.log(`Created Trident task ${id}: ${payload.name}`);
  }

  const GIOVANNI_ID = parseInt(process.env.TRIDENT_ID_GIOVANNI);
  for (let i = 0; i < output.length; i++) {
    const issue = output[i];
    const payload = tridentPayloads[i];
    const existing = existingByName.get(payload.name);
    if (!existing) continue;

    const ownerId = Array.isArray(existing.x_tech_ownership_id)
      ? existing.x_tech_ownership_id[0]
      : existing.x_tech_ownership_id;
    if (ownerId !== GIOVANNI_ID) continue;

    const newAssigneeId = payload.user_ids[0][2][0];
    if (newAssigneeId === GIOVANNI_ID) continue; // unknown assignee — skip

    const currentAssignees = existing.user_ids ?? [];
    if (currentAssignees.length === 1 && currentAssignees[0] === newAssigneeId) continue;

    await writeTridentTask(existing.id, { user_ids: [[6, 0, [newAssigneeId]]] });
    console.log(`Updated assignee on ${existing.id} (${issue.key}): ${issue.assignee}`);
  }
}
