import { fetchWithRetry } from "./httpRetry.js";

async function callTrident(model, method, args, kwargs = {}) {
  const res = await fetchWithRetry(`${process.env.TRIDENT_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      id: 1,
      params: {
        service: "object",
        method: "execute_kw",
        args: [
          process.env.TRIDENT_DB,
          parseInt(process.env.TRIDENT_ID_ARON),
          process.env.TRIDENT_TOKEN,
          model,
          method,
          args,
          kwargs,
        ],
      },
    }),
  }, { label: `Trident (${model}.${method})` });

  if (!res.ok)
    throw new Error(`Trident HTTP error: ${res.status} ${await res.text()}`);

  const data = await res.json();
  if (data.error) throw new Error(`Trident error: ${JSON.stringify(data.error)}`);
  return data.result;
}

export async function fetchExistingTasks() {
  return callTrident(
    "project.task",
    "search_read",
    [[["project_id", "=", parseInt(process.env.TRIDENT_PROJECT_ID)]]],
    { fields: ["name", "x_tech_ownership_id", "user_ids", "stage_id"], limit: 1000 }
  );
}

export async function fetchClusters() {
  // Odoo's default active-record filter hides archived x_cluster rows —
  // verified live that ~61% of all clusters (651/1061) are archived but
  // still valid x_cluster_id targets, so active_test:false is required
  // to see the full set.
  return callTrident(
    "x_cluster",
    "search_read",
    [[]],
    { fields: ["id", "x_name", "x_owner_id"], context: { active_test: false } }
  );
}

export async function fetchProjectFollowers() {
  const [project] = await callTrident(
    "project.project",
    "search_read",
    [[["id", "=", parseInt(process.env.TRIDENT_PROJECT_ID)]]],
    { fields: ["message_partner_ids"] }
  );

  if (!project?.message_partner_ids?.length) return [];

  return callTrident(
    "res.users",
    "search_read",
    [[["partner_id", "in", project.message_partner_ids]]],
    { fields: ["id", "name", "login", "partner_id"] }
  );
}

export async function fetchSprints() {
  return callTrident(
    "x_project_sprint",
    "search_read",
    [[]],
    { fields: ["id", "x_name", "x_date_from", "x_date_to"] }
  );
}

export async function createSprint({ x_name, x_date_from, x_date_to }) {
  const result = await callTrident("x_project_sprint", "create", [[{ x_name, x_date_from, x_date_to }]]);
  return Array.isArray(result) ? result[0] : result;
}

export function matchCluster(clusters, processCode) {
  if (!processCode) return false;

  const code = processCode.toLowerCase();
  let best = null;
  let bestScore = -Infinity;

  for (const cluster of clusters) {
    const name = cluster.x_name.toLowerCase();
    const idx = name.indexOf(code);
    if (idx === -1) continue;

    // Penalize chars that follow the match — devalues "CROSS_31.2" when code is "CROSS_31"
    const trailingChars = name.length - (idx + code.length);
    const score = code.length - trailingChars * 0.5;

    if (score > bestScore) {
      bestScore = score;
      best = cluster;
    }
  }

  return best ? best.id : false;
}

export async function createTridentTask(payload) {
  const result = await callTrident("project.task", "create", [[payload]]);
  return Array.isArray(result) ? result[0] : result;
}

export async function writeTridentTask(id, fields) {
  return callTrident("project.task", "write", [[id], fields]);
}

// Batched variant: one `write` call for many task ids sharing the same
// field values (e.g. reopening a whole cycle's worth of tasks at once).
export async function writeTridentTasks(ids, fields) {
  if (!ids.length) return true;
  return callTrident("project.task", "write", [ids, fields]);
}

export async function createTridentAttachment({ name, datas, mimetype, resId }) {
  const result = await callTrident("ir.attachment", "create", [[{
    name,
    datas,
    mimetype,
    res_model: "project.task",
    res_id: resId,
  }]]);
  return Array.isArray(result) ? result[0] : result;
}

// Batched variant of createTridentAttachment: one `create` call for many
// ir.attachment records (e.g. all attachments a task's new comments need),
// returns the new ids in the same order as `records`.
export async function createTridentAttachments(records) {
  if (!records.length) return [];
  const result = await callTrident("ir.attachment", "create", [records]);
  return Array.isArray(result) ? result : [result];
}

export async function fetchTaskAttachments(taskId) {
  return callTrident(
    "ir.attachment",
    "search_read",
    [[["res_model", "=", "project.task"], ["res_id", "=", taskId]]],
    { fields: ["id", "name"] }
  );
}

export async function fetchAllTaskMessages(taskIds) {
  if (!taskIds.length) return [];
  return callTrident(
    "mail.message",
    "search_read",
    [[["model", "=", "project.task"], ["res_id", "in", taskIds]]],
    { fields: ["id", "res_id", "body"], limit: 10000 }
  );
}

// Direct mail.message.create, NOT project.task.message_post — message_post
// through this JSON-RPC path double-escapes HTML (verified live, see
// plan.md §10.2). subtype_id 2 = "Note", doesn't notify followers — avoids
// a notification storm on the first backlog import.
//
// Batched: one `create` call posts every comment in `records`
// ({taskId, body, attachmentIds}[]), returns the new ids in the same order.
export async function createComments(records) {
  if (!records.length) return [];
  const vals = records.map(({ taskId, body, attachmentIds = [] }) => ({
    model: "project.task",
    res_id: taskId,
    body,
    message_type: "comment",
    subtype_id: 2,
    attachment_ids: [[6, 0, attachmentIds]],
  }));
  const result = await callTrident("mail.message", "create", [vals]);
  return Array.isArray(result) ? result : [result];
}
