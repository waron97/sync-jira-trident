import fs from "fs/promises";
import {
  fetchAllJiraIssues,
  fetchJiraComments,
  fetchJiraAttachmentsForIssue,
  adfToHtml,
  fetchAttachmentBase64,
} from "../util/jira.js";
import {
  fetchExistingTasks,
  fetchClusters,
  fetchProjectFollowers,
  fetchSprints,
  createSprint,
  createTridentTask,
  writeTridentTask,
  createTridentAttachment,
  fetchTaskAttachments,
  fetchAllTaskMessages,
  createComment,
} from "../util/trident.js";
import { resolveAssignee, resolveCluster, resolveOwnership, resolveTag, matchSprint } from "../util/resolve.js";
import { collectCommentMedia, matchAttachmentForMedia, extractSyncedCommentIds } from "../util/comments.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const TASK_KEY_RE = /^\[([A-Z]+-\d+)\]/;

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
    priorityWeek: raw.fields.customfield_11690?.value ?? raw.fields.customfield_11690 ?? null,
    attachments: (raw.fields.attachment ?? []).map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      content: a.content,
    })),
  };
}

export async function uploadIssueAttachments(issue, taskId) {
  for (const att of issue.attachments ?? []) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      console.warn(`Skipping ${att.filename} (${att.size} bytes > cap) on task ${taskId}`);
      continue;
    }
    try {
      const datas = await fetchAttachmentBase64(att.content);
      await createTridentAttachment({ name: att.filename, datas, mimetype: att.mimeType, resId: taskId });
      console.log(`Attached ${att.filename} to task ${taskId}`);
    } catch (e) {
      console.warn(`Failed to attach ${att.filename} to task ${taskId}: ${e.message}`);
    }
  }
}

export function buildTridentPayload(issue, { assignee, cluster, ownership, tag, sprintId }) {
  const JIRA_BROWSE = process.env.JIRA_URL.replace("/rest/api/3", "");

  const payload = {
    name: `[${issue.key}] ${issue.title}`,
    project_id: parseInt(process.env.TRIDENT_PROJECT_ID),
    stage_id: parseInt(process.env.TRIDENT_STARTING_STAGE_ID),
    x_livello_task: "task",
    x_severity_id: resolveSeverity(issue),
    x_tech_ownership_id: ownership.tridentUserId,
    x_cluster_id: cluster.clusterId,
    user_ids: [[6, 0, [assignee.tridentUserId]]],
    description: `<p>Link Jira: <a href="${JIRA_BROWSE}/browse/${issue.key}">${issue.key}</a></p><p>Processo di riferimento: ${issue.processoDiRiferimento ?? ""}</p><p>Richiedente: ${issue.reporter ?? ""}</p><p>Modalità di esecuzione: ${issue.modalitaDiEsecuzione ?? ""}</p><p>Tipologia segnalazione: ${issue.tipologiaSegnalazione ?? ""}</p>${issue.description}`,
  };

  if (tag) {
    payload.tag_ids = [[6, 0, [tag.id]]];
    payload.x_main_tag_id = tag.id;
  }
  if (sprintId) payload.x_sprint_id = sprintId;

  return payload;
}

// Resolves (matching an existing row) or actually creates the missing
// x_project_sprint row — unlike report.js's matchSprint(), this one writes.
// `sprints` is mutated in place so repeat weeks within the same run reuse
// the row instead of creating duplicates.
export async function resolveOrCreateSprint(priorityWeek, sprints) {
  const result = matchSprint(priorityWeek, sprints);
  if (!result.applicable) return null;
  if (result.matchedSprintId) return result.matchedSprintId;
  if (!result.derived) return null;

  const { derivedName, dateFrom, dateTo } = result.derived;
  const newId = await createSprint({ x_name: derivedName, x_date_from: dateFrom, x_date_to: dateTo });
  sprints.push({ id: newId, x_name: derivedName, x_date_from: dateFrom, x_date_to: dateTo });
  console.log(`Created new x_project_sprint ${newId} (${derivedName})`);
  return newId;
}

async function syncCreates(issues, { clusters, allowlist, sprints, existingNames }) {
  let created = 0, skipped = 0, alreadyExists = 0;

  for (const issue of issues) {
    const name = `[${issue.key}] ${issue.title}`;

    const assignee = await resolveAssignee(issue.assignee, allowlist);
    if (assignee.method === "unresolved") {
      skipped++;
      continue;
    }

    if (existingNames.has(name)) {
      alreadyExists++;
      continue;
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
    created++;
  }

  return { created, skipped, alreadyExists };
}

async function syncReopens(existingTasks, currentNames) {
  const resolvedStageId = parseInt(process.env.TRIDENT_RESOLVED_JIRA_STAGE_ID);
  const rejectedStageId = parseInt(process.env.TRIDENT_REJECTED_STAGE_ID);
  const startingStageId = parseInt(process.env.TRIDENT_STARTING_STAGE_ID);

  const toReopen = existingTasks.filter((t) => {
    const stageId = Array.isArray(t.stage_id) ? t.stage_id[0] : t.stage_id;
    return (stageId === resolvedStageId || stageId === rejectedStageId) && currentNames.has(t.name);
  });

  for (const task of toReopen) {
    await writeTridentTask(task.id, { stage_id: startingStageId });
    console.log(`Reopened Trident task ${task.id}: ${task.name}`);
  }

  return toReopen.length;
}

// One Jira HTTP call per existing task per run (no bulk multi-issue comment
// endpoint exists) — fine at current scale, revisit only if it becomes a
// real latency problem. Scope = every existing Trident task with a
// parseable key, not just newly-created ones; old tickets keep
// accumulating Jira discussion too.
async function syncComments(existingTasks) {
  const keyed = [];
  for (const task of existingTasks) {
    const match = task.name.match(TASK_KEY_RE);
    if (match) keyed.push({ task, key: match[1] });
  }
  if (!keyed.length) return 0;

  const allMessages = await fetchAllTaskMessages(keyed.map((k) => k.task.id));
  const syncedByTask = new Map();
  for (const msg of allMessages) {
    const set = syncedByTask.get(msg.res_id) ?? new Set();
    for (const id of extractSyncedCommentIds(msg.body)) set.add(id);
    syncedByTask.set(msg.res_id, set);
  }

  let posted = 0;

  for (const { task, key } of keyed) {
    const synced = syncedByTask.get(task.id) ?? new Set();

    let comments;
    try {
      comments = await fetchJiraComments(key);
    } catch (e) {
      console.warn(`Failed to fetch Jira comments for ${key}: ${e.message}`);
      continue;
    }

    const newComments = comments.filter((c) => !synced.has(String(c.id)));
    if (!newComments.length) continue;

    // Lazy-loaded per task, only if a comment actually references media —
    // most comments are plain text and never need these.
    let jiraAttachments = null;
    let existingAttByName = null;

    for (const comment of newComments) {
      const mediaNodes = collectCommentMedia(comment.body);
      const resolvedMap = new Map();
      const attachmentIds = [];

      if (mediaNodes.length) {
        if (jiraAttachments === null) {
          jiraAttachments = await fetchJiraAttachmentsForIssue(key);
        }
        if (existingAttByName === null) {
          existingAttByName = new Map((await fetchTaskAttachments(task.id)).map((a) => [a.name, a.id]));
        }

        for (const mediaNode of mediaNodes) {
          const matched = matchAttachmentForMedia(mediaNode, jiraAttachments, comment.created);
          if (!matched) continue;

          let tridentAttId = existingAttByName.get(matched.filename);
          if (!tridentAttId) {
            try {
              const datas = await fetchAttachmentBase64(matched.content);
              tridentAttId = await createTridentAttachment({ name: matched.filename, datas, mimetype: matched.mimeType, resId: task.id });
              existingAttByName.set(matched.filename, tridentAttId);
            } catch (e) {
              console.warn(`Failed to upload comment attachment ${matched.filename} for ${key}: ${e.message}`);
              continue;
            }
          }

          resolvedMap.set(mediaNode.id, { tridentAttachmentId: tridentAttId, filename: matched.filename, mimeType: matched.mimeType });
          attachmentIds.push(tridentAttId);
        }
      }

      const html = adfToHtml(comment.body, { resolveMedia: (mediaId) => resolvedMap.get(mediaId) });
      const footer = `<p><small style="color:#999999">↪ Jira comment #${comment.id} · ${comment.author?.displayName ?? "?"} · ${comment.created}</small></p>`;

      const messageId = await createComment({ taskId: task.id, body: html + footer, attachmentIds });
      console.log(`Posted comment ${messageId} on task ${task.id} (${key}, Jira comment #${comment.id})`);
      posted++;
    }
  }

  return posted;
}

export async function runCommand(options) {
  const [rawIssues, clusters, allowlist, sprints, existingTasks] = await Promise.all([
    fetchAllJiraIssues(),
    fetchClusters(),
    fetchProjectFollowers(),
    fetchSprints(),
    fetchExistingTasks(),
  ]);

  const issues = rawIssues.map(normalizeIssue);

  const outPath = options.output ?? "output.json";
  await fs.writeFile(outPath, JSON.stringify(issues, null, 2), "utf-8");
  console.log(`Wrote ${issues.length} issues to ${outPath}`);

  const existingNames = new Set(existingTasks.map((t) => t.name));
  const { created, skipped, alreadyExists } = await syncCreates(issues, { clusters, allowlist, sprints, existingNames });
  console.log(`${created} tasks created, ${skipped} skipped (no matching project member), ${alreadyExists} already existed`);

  const currentNames = new Set(issues.map((i) => `[${i.key}] ${i.title}`));
  const reopened = await syncReopens(existingTasks, currentNames);
  console.log(`${reopened} tasks reopened`);

  const commentsPosted = await syncComments(existingTasks);
  console.log(`${commentsPosted} Jira comments synced to Trident`);
}
