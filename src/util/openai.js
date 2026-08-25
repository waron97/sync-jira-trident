import fetch from "node-fetch";

const MATCH_SCHEMA = {
  type: "object",
  properties: {
    match: { type: ["string", "null"] },
    confidence: { type: "number" },
  },
  required: ["match", "confidence"],
  additionalProperties: false,
};

async function callOpenAI(messages) {
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: { name: "match_result", strict: true, schema: MATCH_SCHEMA },
        },
      }),
    });

    if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);

    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (e) {
    console.warn(`OpenAI call failed: ${e.message}`);
    return { match: null, confidence: 0 };
  }
}

export function meetsConfidence(result) {
  const threshold = parseFloat(process.env.OPENAI_CONFIDENCE_THRESHOLD ?? "0.7");
  return result.match !== null && result.confidence >= threshold;
}

// Assignee false positives misroute a real task to the wrong person's desk,
// so this needs a much stricter bar than the generic cluster-match threshold.
export function meetsAssigneeConfidence(result) {
  const threshold = parseFloat(process.env.OPENAI_ASSIGNEE_CONFIDENCE_THRESHOLD ?? "0.9");
  return result.match !== null && result.confidence >= threshold;
}

export async function resolveAssigneeLLM(rawAssignee, allowlistNames) {
  return callOpenAI([
    {
      role: "system",
      content:
        "You match a raw Jira assignee string to one name from a fixed list of known engineers. " +
        "Only return a match if the input is clearly the SAME PERSON written differently — a typo, " +
        "a login-style format (e.g. \"luca.carnevale\"), a first-name/last-name order swap, or an " +
        "obvious abbreviation of that exact full name. " +
        "Sharing only a first name, only a last name, or only an initial is NOT sufficient evidence — " +
        "two different people can have the same first name. If you are not near-certain it's the same " +
        "individual, return match: null. When in doubt, prefer null over a guess.",
    },
    {
      role: "user",
      content: `Raw Jira assignee: "${rawAssignee}"\nKnown engineers: ${JSON.stringify(allowlistNames)}`,
    },
  ]);
}

export async function resolveClusterLLM(summary, processCode, clusterNames) {
  return callOpenAI([
    {
      role: "system",
      content:
        "You match a Jira ticket to the single best-fitting cluster (work package) name from a fixed list. " +
        "If nothing clearly fits, return match: null.",
    },
    {
      role: "user",
      content: `Ticket summary: "${summary}"\nProcesso di riferimento: "${processCode ?? ""}"\nCluster names: ${JSON.stringify(clusterNames)}`,
    },
  ]);
}
