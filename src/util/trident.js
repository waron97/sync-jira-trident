import fetch from "node-fetch";

async function callTrident(model, method, args, kwargs = {}) {
  const res = await fetch(`${process.env.TRIDENT_URL}/jsonrpc`, {
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
  });

  const data = await res.json();
  if (data.error) throw new Error(`Trident error: ${JSON.stringify(data.error)}`);
  return data.result;
}

export async function fetchExistingTasks() {
  return callTrident(
    "project.task",
    "search_read",
    [[["project_id", "=", parseInt(process.env.TRIDENT_PROJECT_ID)]]],
    { fields: ["name", "x_tech_ownership_id", "user_ids"], limit: 1000 }
  );
}

export async function fetchClusters() {
  return callTrident(
    "x_cluster",
    "search_read",
    [[]],
    { fields: ["id", "x_name"] }
  );
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
