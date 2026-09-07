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
  writeTridentTasks,
  createTridentAttachment,
  createTridentAttachments,
  fetchTaskAttachments,
  fetchAllTaskMessages,
  createComments,
} from "../util/trident.js";
import { resolveAssignee, resolveCluster, resolveOwnership, resolveTag, matchSprint } from "../util/resolve.js";
import { collectCommentMedia, matchAttachmentForMedia, extractSyncedCommentIds } from "../util/comments.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const TASK_KEY_RE = /^\[([A-Z]+-\d+)\]/;

export function extractTaskKey(name) {
  return name.match(TASK_KEY_RE)?.[1] ?? null;
}

// [<jira key>][<processo di riferimento>] <jira title> — the processo
// bracket is omitted when the issue has no "Processo di riferimento" value.
// Dedup/reopen matching keys off extractTaskKey(), not this string, so
// title text changes (Jira-side or in this composition) never cause a
// re-created duplicate task.
export function buildTaskName(issue) {
  const processo = issue.processoDiRiferimento ? `[${issue.processoDiRiferimento}]` : "";
  return `[${issue.key}]${processo} ${issue.title}`;
}

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
    name: buildTaskName(issue),
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

async function syncCreates(issues, { clusters, allowlist, sprints, existingKeys }) {
  let created = 0, skipped = 0, alreadyExists = 0;

  for (const issue of issues) {
    const assignee = await resolveAssignee(issue.assignee, allowlist);
    if (assignee.method === "unresolved") {
      skipped++;
      continue;
    }

    if (existingKeys.has(issue.key)) {
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

async function syncReopens(existingTasks, currentKeys) {
  const resolvedStageId = parseInt(process.env.TRIDENT_RESOLVED_JIRA_STAGE_ID);
  const rejectedStageId = parseInt(process.env.TRIDENT_REJECTED_STAGE_ID);
  const startingStageId = parseInt(process.env.TRIDENT_STARTING_STAGE_ID);

  const toReopen = existingTasks.filter((t) => {
    const stageId = Array.isArray(t.stage_id) ? t.stage_id[0] : t.stage_id;
    const key = extractTaskKey(t.name);
    return (stageId === resolvedStageId || stageId === rejectedStageId) && key && currentKeys.has(key);
  });

  if (toReopen.length) {
    await writeTridentTasks(toReopen.map((t) => t.id), { stage_id: startingStageId });
    for (const task of toReopen) console.log(`Reopened Trident task ${task.id}: ${task.name}`);
  }

  return toReopen.length;
}

const COMMENT_CREATE_CHUNK_SIZE = 50;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Resolves every media node across a task's new comments against Jira's
// attachment list, batch-uploading whatever isn't already a Trident
// attachment in ONE ir.attachment.create call (was: one call per
// attachment). Returns Map<mediaNodeId, {tridentAttachmentId, filename, mimeType}>.
async function resolveTaskCommentAttachments(task, key, mediaNodesByComment, jiraAttachments) {
  const existingAttByName = new Map((await fetchTaskAttachments(task.id)).map((a) => [a.name, a.id]));
  const matchedByMediaId = new Map();
  const toCreate = [];

  for (const { comment, mediaNodes } of mediaNodesByComment) {
    for (const mediaNode of mediaNodes) {
      const matched = matchAttachmentForMedia(mediaNode, jiraAttachments, comment.created);
      if (!matched) continue;
      matchedByMediaId.set(mediaNode.id, matched);

      if (existingAttByName.has(matched.filename)) continue;
      if (toCreate.some((r) => r.name === matched.filename)) continue;

      try {
        const datas = await fetchAttachmentBase64(matched.content);
        toCreate.push({ name: matched.filename, datas, mimetype: matched.mimeType, res_model: "project.task", res_id: task.id });
      } catch (e) {
        console.warn(`Failed to fetch comment attachment ${matched.filename} for ${key}: ${e.message}`);
      }
    }
  }

  if (toCreate.length) {
    const newIds = await createTridentAttachments(toCreate);
    newIds.forEach((id, i) => existingAttByName.set(toCreate[i].name, id));
  }

  const resolvedMap = new Map();
  for (const [mediaId, matched] of matchedByMediaId) {
    const tridentAttachmentId = existingAttByName.get(matched.filename);
    if (tridentAttachmentId) resolvedMap.set(mediaId, { tridentAttachmentId, filename: matched.filename, mimeType: matched.mimeType });
  }
  return resolvedMap;
}

// Builds the (not-yet-posted) comment records for one task: fetches Jira
// comments, filters to unsynced ones, resolves/uploads any attachments
// they reference, and renders each comment's HTML body + idempotency
// footer. Posting itself happens in a later, batched phase (syncComments).
async function resolveTaskComments(task, key, synced) {
  let comments;
  try {
    comments = await fetchJiraComments(key);
  } catch (e) {
    console.warn(`Failed to fetch Jira comments for ${key}: ${e.message}`);
    return [];
  }

  const newComments = comments.filter((c) => !synced.has(String(c.id)));
  if (!newComments.length) return [];

  const mediaNodesByComment = newComments.map((comment) => ({ comment, mediaNodes: collectCommentMedia(comment.body) }));
  const needsMedia = mediaNodesByComment.some((m) => m.mediaNodes.length);

  let resolvedMap = new Map();
  if (needsMedia) {
    const jiraAttachments = await fetchJiraAttachmentsForIssue(key);
    resolvedMap = await resolveTaskCommentAttachments(task, key, mediaNodesByComment, jiraAttachments);
  }

  return newComments.map((comment) => {
    const html = adfToHtml(comment.body, { resolveMedia: (mediaId) => resolvedMap.get(mediaId) });
    const footer = `<p><small style="color:#999999">↪ Jira comment #${comment.id} · ${comment.author?.displayName ?? "?"} · ${comment.created}</small></p>`;
    const attachmentIds = collectCommentMedia(comment.body)
      .map((m) => resolvedMap.get(m.id)?.tridentAttachmentId)
      .filter(Boolean);

    return { taskId: task.id, body: html + footer, attachmentIds, logKey: key, commentId: comment.id };
  });
}

// One Jira HTTP call per task (no bulk multi-issue comment endpoint exists).
// Rate limiting is handled by fetchWithRetry's 429 backoff, not by batching.
// Posting to Trident is batched: every resolved comment across all checked
// tasks goes out via as few mail.message.create calls as possible.
async function syncComments(tasks) {
  const keyed = [];
  for (const task of tasks) {
    const key = extractTaskKey(task.name);
    if (key) keyed.push({ task, key });
  }
  if (!keyed.length) return 0;

  const allMessages = await fetchAllTaskMessages(keyed.map((k) => k.task.id));
  const syncedByTask = new Map();
  for (const msg of allMessages) {
    const set = syncedByTask.get(msg.res_id) ?? new Set();
    for (const id of extractSyncedCommentIds(msg.body)) set.add(id);
    syncedByTask.set(msg.res_id, set);
  }

  const pending = [];
  for (const { task, key } of keyed) {
    const synced = syncedByTask.get(task.id) ?? new Set();
    pending.push(...(await resolveTaskComments(task, key, synced)));
  }
  if (!pending.length) return 0;

  let posted = 0;
  for (const batch of chunk(pending, COMMENT_CREATE_CHUNK_SIZE)) {
    const ids = await createComments(batch);
    batch.forEach((rec, i) => {
      console.log(`Posted comment ${ids[i]} on task ${rec.taskId} (${rec.logKey}, Jira comment #${rec.commentId})`);
    });
    posted += batch.length;
  }

  return posted;
}

// Fetch + create-only pass: Jira issues, Trident lookups, and syncCreates.
// Reused by both the scheduled `start` create tick (every 10 min) and the
// one-shot `run` CLI command. Never touched by the update path below.
export async function runCreates(options) {
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

  const existingKeys = new Set(existingTasks.map((t) => extractTaskKey(t.name)).filter(Boolean));
  const { created, skipped, alreadyExists } = await syncCreates(issues, { clusters, allowlist, sprints, existingKeys });
  console.log(`${created} tasks created, ${skipped} skipped (no matching project member), ${alreadyExists} already existed`);

  return { issues, existingTasks };
}

// Reopen-check + comment-sync pass, both run over the full existingTasks
// list every time — no batching/cycling; Jira 429s are handled by
// fetchWithRetry's backoff instead.
export async function runUpdates({ issues, existingTasks }) {
  const currentKeys = new Set(issues.map((i) => i.key));
  const reopened = await syncReopens(existingTasks, currentKeys);
  console.log(`${reopened} tasks reopened`);

  const commentsPosted = await syncComments(existingTasks);
  console.log(`${commentsPosted} Jira comments synced to Trident (${existingTasks.length} tasks checked)`);
}

export async function runCommand(options) {
  const { issues, existingTasks } = await runCreates(options);
  await runUpdates({ issues, existingTasks });
}
