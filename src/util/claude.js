import { spawn } from "node:child_process";

const MATCH_SCHEMA = {
  type: "object",
  properties: {
    match: { type: ["string", "null"] },
    confidence: { type: "number" },
  },
  required: ["match", "confidence"],
  additionalProperties: false,
};

// haiku + MAX_THINKING_TOKENS=0: this is a trivial one-shot classification,
// not an agentic task — sonnet with default extended thinking costs ~$0.12
// and ~5s per call (mostly system-prompt cache creation + thinking tokens),
// which is untenable at hundreds of tickets per sync tick. This config runs
// ~$0.01 and ~1.5s per call instead.
//
// Uses spawn (not execFile) with stdin explicitly ignored: execFile always
// leaves the child's stdin open as an unclosed pipe, which makes the CLI
// stall ~3s waiting for stdin before it gives up and proceeds — spawn with
// stdio "ignore" avoids that stall entirely.
// Disabled for now — shells out to a per-call `claude` CLI process that was
// burning through token quota. Short-circuits to "no match" so callers fall
// through to their existing unresolved/skip path unchanged. Re-enable by
// removing this early return.
const LLM_FALLBACK_ENABLED = false;

function callClaude(systemPrompt, userPrompt) {
  if (!LLM_FALLBACK_ENABLED) {
    return Promise.resolve({ match: null, confidence: 0 });
  }

  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p", userPrompt,
        "--model", "haiku",
        "--system-prompt", systemPrompt,
        "--output-format", "json",
        "--json-schema", JSON.stringify(MATCH_SCHEMA),
        "--permission-mode", "dontAsk",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MAX_THINKING_TOKENS: "0" } }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", (e) => {
      console.warn(`claude call failed: ${e.message}`);
      resolve({ match: null, confidence: 0 });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`claude call failed: exit ${code}: ${stderr.trim()}`);
        return resolve({ match: null, confidence: 0 });
      }
      try {
        resolve(JSON.parse(stdout).structured_output);
      } catch (e) {
        console.warn(`claude call failed to parse output: ${e.message}`);
        resolve({ match: null, confidence: 0 });
      }
    });
  });
}

export function meetsConfidence(result) {
  const threshold = parseFloat(process.env.CLAUDE_CONFIDENCE_THRESHOLD ?? "0.7");
  return result.match !== null && result.confidence >= threshold;
}

// Assignee false positives misroute a real task to the wrong person's desk,
// so this needs a much stricter bar than the generic cluster-match threshold.
export function meetsAssigneeConfidence(result) {
  const threshold = parseFloat(process.env.CLAUDE_ASSIGNEE_CONFIDENCE_THRESHOLD ?? "0.9");
  return result.match !== null && result.confidence >= threshold;
}

export async function resolveAssigneeLLM(rawAssignee, allowlistNames) {
  return callClaude(
    "You match a raw Jira assignee string to one name from a fixed list of known engineers. " +
      "Only return a match if the input is clearly the SAME PERSON written differently — a typo, " +
      "a login-style format (e.g. \"luca.carnevale\"), a first-name/last-name order swap, or an " +
      "obvious abbreviation of that exact full name. " +
      "Sharing only a first name, only a last name, or only an initial is NOT sufficient evidence — " +
      "two different people can have the same first name. If you are not near-certain it's the same " +
      "individual, return match: null. When in doubt, prefer null over a guess.",
    `Raw Jira assignee: "${rawAssignee}"\nKnown engineers: ${JSON.stringify(allowlistNames)}`
  );
}

export async function resolveClusterLLM(summary, processCode, clusterNames) {
  return callClaude(
    "You match a Jira ticket to the single best-fitting cluster (work package) name from a fixed list. " +
      "If nothing clearly fits, return match: null.",
    `Ticket summary: "${summary}"\nProcesso di riferimento: "${processCode ?? ""}"\nCluster names: ${JSON.stringify(clusterNames)}`
  );
}
