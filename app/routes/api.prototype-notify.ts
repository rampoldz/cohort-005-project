// PROTOTYPE — throwaway. Wayfinder ticket #31.
// Sends one random sample Notification to the current user, so the unread signal
// can be watched arriving live.
import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/api.prototype-notify";
import { db } from "~/db";
import { users, teamMembers, TeamMemberRole } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { samplesFor, triggerSample } from "~/lib/prototype-knock.server";

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  const user = userId
    ? db.select().from(users).where(eq(users.id, userId)).get()
    : null;
  if (!user) return { ok: false, status: 401, error: "No user selected" };

  const isTeamAdmin = !!db
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, user.id),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();

  const samples = samplesFor(user.role, isTeamAdmin);
  const sample = samples[Math.floor(Math.random() * samples.length)];
  return triggerSample(user, sample);
}
