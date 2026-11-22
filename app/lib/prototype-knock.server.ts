// PROTOTYPE — throwaway. Wayfinder ticket #31 "What does the Notification surface look like?"
// Triggers sample Notifications through Knock so the surface variants have real feed items.
// No imports from the app on purpose: scripts/prototype-seed-notifications.ts uses this too.

export const PROTOTYPE_WORKFLOW_KEY = "prototype-notification";

export interface Sample {
  body: string;
  url: string;
}

const TS = `"Introduction to TypeScript"`;
const DS = `"Design Systems with Tailwind"`;

const SAMPLES = {
  admin: [
    { body: `Emma Wilson raised a refund request for ${TS} ($49.00).`, url: "/admin/refunds" },
    {
      body: `Bossy McBossface raised a refund request for a team licence for ${DS} ($245.00).`,
      url: "/admin/refunds",
    },
    { body: `James Park raised a refund request for ${DS} ($79.00).`, url: "/admin/refunds" },
  ],
  instructor: [
    { body: `Emma Wilson asked a question on "Primitive Types" in ${TS}.`, url: "/instructor/questions" },
    { body: `James Park asked a question on "What is TypeScript?" in ${TS}.`, url: "/instructor/questions" },
    { body: `A Platform Admin archived your course ${DS}.`, url: "/instructor/3" },
    { body: `A Platform Admin published your course ${TS}.`, url: "/instructor/1" },
  ],
  student: [
    {
      body: `A Platform Admin approved your refund request for ${DS}. $79.00 is on its way back to you and your enrollment has ended.`,
      url: "/settings",
    },
    {
      body: `A Platform Admin declined your refund request for ${TS}. You keep your enrollment and can raise a new one.`,
      url: "/settings",
    },
    {
      body: `Sarah Chen replied to your question on "Primitive Types" in ${TS}.`,
      url: "/courses/introduction-to-typescript/lessons/4",
    },
    { body: `A Platform Admin changed your role to Student.`, url: "/courses" },
  ],
  teamAdmin: [
    {
      body: `Olivia Martinez claimed a seat on ${DS}. 1 of 5 is now claimed, so this team licence can no longer be refunded.`,
      url: "/team",
    },
    { body: `Liam Thompson claimed a seat on ${TS}. 3 of 5 are now claimed.`, url: "/team" },
    {
      body: `A Platform Admin approved your refund request for the team licence for ${TS}. $245.00 is on its way back to you and its 5 unclaimed seats can no longer be claimed.`,
      url: "/team",
    },
  ],
} satisfies Record<string, Sample[]>;

export function samplesFor(role: string, isTeamAdmin: boolean): Sample[] {
  const byRole =
    role === "admin" ? SAMPLES.admin : role === "instructor" ? SAMPLES.instructor : SAMPLES.student;
  return isTeamAdmin ? [...SAMPLES.teamAdmin, ...byRole] : byRole;
}

export async function triggerSample(
  recipient: { id: number; name: string },
  sample: Sample
): Promise<{ ok: boolean; status: number; error?: string }> {
  const res = await fetch(
    `https://api.knock.app/v1/workflows/${PROTOTYPE_WORKFLOW_KEY}/trigger`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.KNOCK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipients: [{ id: String(recipient.id), name: recipient.name }],
        data: { body: sample.body, url: sample.url },
      }),
    }
  );
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, error: await res.text() };
}
