function collectMediaNodes(node, acc) {
  if (!node) return acc;
  if (node.type === "media" || node.type === "mediaInline") {
    acc.push({ id: node.attrs?.id, alt: node.attrs?.alt ?? null });
  }
  for (const child of node.content ?? []) collectMediaNodes(child, acc);
  return acc;
}

export function collectCommentMedia(commentBody) {
  return collectMediaNodes(commentBody, []);
}

const TIMESTAMP_MATCH_WINDOW_MS = 5000;

// Jira's ADF media node id is a media-platform UUID, a different id space
// than fields.attachment[].id — there's no documented mapping between them.
// Best-effort match: filename (via the node's `alt`, only set on images) or
// otherwise the attachment created closest in time to the comment, within a
// tight window. See plan.md §10.1.
export function matchAttachmentForMedia(mediaNode, jiraAttachments, commentCreated) {
  if (mediaNode.alt) {
    const byName = jiraAttachments.find((a) => a.filename === mediaNode.alt);
    if (byName) return byName;
  }

  const commentTime = new Date(commentCreated).getTime();
  let best = null;
  let bestDiff = Infinity;

  for (const att of jiraAttachments) {
    const diff = Math.abs(new Date(att.created).getTime() - commentTime);
    if (diff < TIMESTAMP_MATCH_WINDOW_MS && diff < bestDiff) {
      best = att;
      bestDiff = diff;
    }
  }

  return best;
}

export function extractSyncedCommentIds(body) {
  const ids = new Set();
  const re = /Jira comment #(\d+)/g;
  let m;
  while ((m = re.exec(body ?? "")) !== null) ids.add(m[1]);
  return ids;
}
