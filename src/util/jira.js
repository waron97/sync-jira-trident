import { fetchWithRetry } from "./httpRetry.js";

function applyMarks(text, marks = []) {
  return marks.reduce((t, mark) => {
    switch (mark.type) {
      case "strong": return `<strong>${t}</strong>`;
      case "em": return `<em>${t}</em>`;
      case "underline": return `<u>${t}</u>`;
      case "strike": return `<s>${t}</s>`;
      case "code": return `<code>${t}</code>`;
      case "link": return `<a href="${mark.attrs?.href ?? ""}">${t}</a>`;
      default: return t;
    }
  }, text);
}

// ctx.resolveMedia(mediaId) -> {tridentAttachmentId, filename, mimeType} | undefined.
// Only comment-sync passes this; description conversion has no attachment
// context, so media nodes there just render as an unresolved placeholder.
export function adfToHtml(node, ctx = {}) {
  if (!node) return "";

  if (node.type === "text") {
    return applyMarks(node.text ?? "", node.marks);
  }

  const inner = (node.content ?? []).map((n) => adfToHtml(n, ctx)).join("");

  switch (node.type) {
    case "doc":           return inner;
    case "paragraph":     return `<p>${inner}</p>`;
    case "heading":       return `<h${node.attrs?.level ?? 1}>${inner}</h${node.attrs?.level ?? 1}>`;
    case "blockquote":    return `<blockquote>${inner}</blockquote>`;
    case "bulletList":    return `<ul>${inner}</ul>`;
    case "orderedList":   return `<ol>${inner}</ol>`;
    case "listItem":      return `<li>${inner}</li>`;
    case "codeBlock":     return `<pre><code>${inner}</code></pre>`;
    case "hardBreak":     return "<br/>";
    case "rule":          return "<hr/>";
    case "panel":         return `<div class="panel">${inner}</div>`;
    case "expand":
    case "nestedExpand":  return `<details><summary>${node.attrs?.title ?? ""}</summary>${inner}</details>`;
    case "inlineCard":    return `<a href="${node.attrs?.url ?? ""}">${node.attrs?.url ?? ""}</a>`;
    case "mention":       return `<strong>${node.attrs?.text ?? ""}</strong>`;
    case "media":
    case "mediaInline": {
      // No resolver at all (e.g. description build, which has no attachment
      // context available at that point) -> drop silently, same as before
      // this case existed; the image still exists as a real task attachment
      // via uploadIssueAttachments, just not rendered inline. Only show the
      // placeholder when a resolver was actually attempted and failed
      // (comment-sync) — that's a genuine, worth-flagging match failure.
      if (!ctx.resolveMedia) return "";
      const resolved = ctx.resolveMedia(node.attrs?.id);
      if (!resolved) return `<em>[allegato non sincronizzato]</em>`;
      if (resolved.mimeType?.startsWith("image/")) {
        return `<img src="/web/image/${resolved.tridentAttachmentId}" alt="${resolved.filename}" style="max-width:400px"/>`;
      }
      return `<a href="/web/content/${resolved.tridentAttachmentId}?download=true">${resolved.filename}</a>`;
    }
    default:              return inner;
  }
}

const JQL = `project = TESTML AND status in ("DA VERIFICARE","IN RESOLUTION","SRG Business Check") AND cf[10312] in ("Bug","Bug UX/UI","Enhancement","Verifica")`;
const FIELDS = [
  "summary",
  "description",
  "assignee",
  "status",
  "customfield_10460",
  "customfield_10222",
  "customfield_10251",
  "customfield_10312",
  "customfield_11690",
  "priority",
  "reporter",
  "attachment",
];

export async function fetchJiraIssue(key) {
  const BASE_URL = process.env.JIRA_URL;
  const AUTH = Buffer.from(
    `${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`
  ).toString("base64");

  const res = await fetchWithRetry(`${BASE_URL}/issue/${key}?fields=${FIELDS.join(",")}`, {
    headers: {
      Authorization: `Basic ${AUTH}`,
      Accept: "application/json",
    },
  }, { label: "Jira" });

  if (!res.ok)
    throw new Error(`Jira API error: ${res.status} ${await res.text()}`);

  return res.json();
}

async function searchJiraIssues(jql, fields) {
  const BASE_URL = process.env.JIRA_URL;
  const AUTH = Buffer.from(
    `${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`
  ).toString("base64");

  const issues = [];
  let nextPageToken = undefined;
  const maxResults = 50;

  while (true) {
    const body = { jql, fields, maxResults };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await fetchWithRetry(`${BASE_URL}/search/jql`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${AUTH}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    }, { label: "Jira" });

    if (!res.ok)
      throw new Error(`Jira API error: ${res.status} ${await res.text()}`);

    const data = await res.json();
    issues.push(...data.issues);
    if (!data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  return issues;
}

export async function fetchAllJiraIssues() {
  return searchJiraIssues(JQL, FIELDS);
}

export async function fetchJiraComments(key) {
  const BASE_URL = process.env.JIRA_URL;
  const AUTH = Buffer.from(
    `${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`
  ).toString("base64");

  const comments = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const res = await fetchWithRetry(`${BASE_URL}/issue/${key}/comment?startAt=${startAt}&maxResults=${maxResults}`, {
      headers: { Authorization: `Basic ${AUTH}`, Accept: "application/json" },
    }, { label: "Jira" });

    if (!res.ok)
      throw new Error(`Jira API error: ${res.status} ${await res.text()}`);

    const data = await res.json();
    comments.push(...data.comments);
    startAt += data.comments.length;
    if (data.comments.length === 0 || startAt >= data.total) break;
  }

  return comments;
}

// Lightweight — only the attachment field, for the comment-media matching
// heuristic. Distinct from fetchJiraIssue(), which pulls the full FIELDS set.
export async function fetchJiraAttachmentsForIssue(key) {
  const BASE_URL = process.env.JIRA_URL;
  const AUTH = Buffer.from(
    `${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`
  ).toString("base64");

  const res = await fetchWithRetry(`${BASE_URL}/issue/${key}?fields=attachment`, {
    headers: { Authorization: `Basic ${AUTH}`, Accept: "application/json" },
  }, { label: "Jira" });

  if (!res.ok)
    throw new Error(`Jira API error: ${res.status} ${await res.text()}`);

  const data = await res.json();
  return (data.fields.attachment ?? []).map((a) => ({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    content: a.content,
    created: a.created,
  }));
}

export async function fetchAttachmentBase64(contentUrl) {
  const AUTH = Buffer.from(
    `${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`
  ).toString("base64");

  const res = await fetchWithRetry(contentUrl, {
    headers: { Authorization: `Basic ${AUTH}` },
  }, { label: "Jira attachment" });

  if (!res.ok)
    throw new Error(`Jira attachment error: ${res.status} ${await res.text()}`);

  return Buffer.from(await res.arrayBuffer()).toString("base64");
}
