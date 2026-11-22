// PROTOTYPE — throwaway. Wayfinder ticket #31.
// Run: npm run prototype:notifications
// 1. If KNOCK_SERVICE_TOKEN is in .env, creates the one prototype workflow in Knock's
//    development environment (an in-app feed step whose body is `{{ data.body }}`).
// 2. Sends every sample Notification to one seeded person per role.
import {
  PROTOTYPE_WORKFLOW_KEY,
  samplesFor,
  triggerSample,
} from "../app/lib/prototype-knock.server";

process.loadEnvFile(".env");

const MAPI = "https://control.knock.app/v1";

// Seeded ids are the same on every machine (scripts/seed.ts).
const PEOPLE = [
  { id: 1, name: "Alex Rivera", role: "admin", isTeamAdmin: false },
  { id: 2, name: "Sarah Chen", role: "instructor", isTeamAdmin: false },
  { id: 5, name: "Emma Wilson", role: "student", isTeamAdmin: false },
  { id: 10, name: "Bossy McBossface", role: "student", isTeamAdmin: true },
];

async function mapi(path: string, init: RequestInit = {}) {
  const res = await fetch(`${MAPI}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.KNOCK_SERVICE_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text}`);
  return JSON.parse(text);
}

async function upsertWorkflow() {
  const channels = await mapi("/channels?environment=development");
  const feed = (channels.entries ?? []).find(
    (c: { id: string }) => c.id === process.env.KNOCK_FEED_CHANNEL_ID
  );
  if (!feed) {
    throw new Error(
      `No channel with id KNOCK_FEED_CHANNEL_ID. Channels: ${JSON.stringify(
        (channels.entries ?? []).map((c: { id: string; key: string }) => [c.key, c.id])
      )}`
    );
  }
  const result = await mapi(
    `/workflows/${PROTOTYPE_WORKFLOW_KEY}?environment=development&commit=true&commit_message=prototype`,
    {
      method: "PUT",
      body: JSON.stringify({
        workflow: {
          name: "PROTOTYPE notification (throwaway)",
          steps: [
            {
              type: "channel",
              ref: "in_app_feed_1",
              channel_key: feed.key,
              template: {
                markdown_body: "{{ data.body }}",
                action_url: "{{ data.url }}",
              },
            },
          ],
        },
      }),
    }
  );
  console.log(`workflow ${PROTOTYPE_WORKFLOW_KEY}: valid=${result.workflow?.valid}`);
}

if (process.env.KNOCK_SERVICE_TOKEN) {
  await upsertWorkflow();
} else {
  console.log("No KNOCK_SERVICE_TOKEN: assuming the workflow already exists.");
}

for (const person of PEOPLE) {
  for (const sample of samplesFor(person.role, person.isTeamAdmin)) {
    // A freshly committed workflow takes a few seconds to become triggerable.
    let r = await triggerSample(person, sample);
    for (let i = 0; i < 10 && r.status === 404; i++) {
      await new Promise((done) => setTimeout(done, 2000));
      r = await triggerSample(person, sample);
    }
    console.log(`${r.ok ? "sent" : `FAILED ${r.status} ${r.error}`}  -> ${person.name}: ${sample.body.slice(0, 60)}`);
    if (!r.ok) process.exit(1);
  }
}
