import fetch from "node-fetch";

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

export function adfToHtml(node) {
  if (!node) return "";

  if (node.type === "text") {
    return applyMarks(node.text ?? "", node.marks);
  }

  const inner = (node.content ?? []).map(adfToHtml).join("");

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
    default:              return inner;
  }
}

const JQL = `status in ("DA VERIFICARE","IN RESOLUTION") AND assignee in ("Aron Winkler","Selene Verna","Licia Matarrese") AND cf[10312] in ("Bug","Bug UX/UI","Enhancement")`;
const FIELDS = [
  "summary",
  "description",
  "assignee",
  "status",
  "customfield_10460",
  "customfield_10222",
  "customfield_10251",
  "customfield_10312",
  "priority",
  "reporter",
];

export async function fetchJiraIssue(key) {
  const BASE_URL = process.env.JIRA_URL;
  const AUTH = Buffer.from(
    `${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`
  ).toString("base64");

  const res = await fetch(`${BASE_URL}/issue/${key}?fields=${FIELDS.join(",")}`, {
    headers: {
      Authorization: `Basic ${AUTH}`,
      Accept: "application/json",
    },
  });

  if (!res.ok)
    throw new Error(`Jira API error: ${res.status} ${await res.text()}`);

  return res.json();
}

export async function fetchAllJiraIssues() {
  const BASE_URL = process.env.JIRA_URL;
  const AUTH = Buffer.from(
    `${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`
  ).toString("base64");

  const issues = [];
  let nextPageToken = undefined;
  const maxResults = 50;

  while (true) {
    const body = { jql: JQL, fields: FIELDS, maxResults };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await fetch(`${BASE_URL}/search/jql`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${AUTH}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok)
      throw new Error(`Jira API error: ${res.status} ${await res.text()}`);

    const data = await res.json();
    issues.push(...data.issues);
    if (!data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  return issues;
}
