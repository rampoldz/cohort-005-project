import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses, users } from "~/db/schema";
import { eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { sendEmail, type Email } from "~/lib/email.server";
import {
  raiseRefundRequest,
  withdrawRefundRequest,
  type RefundRefusalReason,
} from "~/lib/refund-requests.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

// The same address raises a Refund Request and takes an Open one back.
const refundActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("raise"),
    reason: z
      .string()
      .trim()
      .min(10, "Tell us a little more about why you want a refund.")
      .max(1000, "Please keep your reason under 1000 characters."),
    // The checkbox under the warning. Absent when unticked; the Refund Request
    // module is what refuses a request without it.
    acknowledgeWarning: z.string().optional(),
  }),
  z.object({
    intent: z.literal("withdraw"),
    refundRequestId: z.coerce.number().int().positive(),
  }),
]);

// How each reason a purchase can't be refunded is reported over HTTP. The
// reasons themselves, and their wording, belong to the Refund Request module.
const REFUSAL_STATUS: Record<RefundRefusalReason, number> = {
  no_purchase: 403,
  final_purchase: 403,
  request_in_progress: 409,
  already_refunded: 409,
  team_seat_claimed: 403,
  window_closed: 403,
  watched_too_much: 403,
  completed_too_much: 403,
  warning_not_acknowledged: 400,
  request_not_found: 404,
  request_not_open: 409,
};

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

/** The confirmation the learner gets in their inbox. */
function buildRefundRequestEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}): Email {
  return {
    to: input.learnerEmail,
    subject: `Refund requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your refund request for "${input.courseTitle}".`,
      `The refund is for ${formatPrice(input.amount)}, the amount you paid.`,
      "",
      "Our team reviews every refund request by hand. The course is locked for you while they do, and your progress is kept as you left it. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const learner = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!learner) {
    throw data("User not found", { status: 404 });
  }

  const parsed = parseFormData(await request.formData(), refundActionSchema);

  if (!parsed.success) {
    const firstError = Object.values(parsed.errors)[0];
    throw data(firstError ?? "That refund request could not be read.", {
      status: 400,
    });
  }

  if (parsed.data.intent === "withdraw") {
    const withdrawal = withdrawRefundRequest(
      currentUserId,
      parsed.data.refundRequestId
    );

    if (!withdrawal.withdrawn) {
      throw data(withdrawal.message, {
        status: REFUSAL_STATUS[withdrawal.reason],
      });
    }

    return { withdrawn: true };
  }

  const result = raiseRefundRequest(
    currentUserId,
    course.id,
    parsed.data.reason,
    parsed.data.acknowledgeWarning === "on"
  );

  if (!result.raised) {
    throw data(result.message, { status: REFUSAL_STATUS[result.reason] });
  }

  sendEmail(
    buildRefundRequestEmail({
      learnerName: learner.name,
      learnerEmail: learner.email,
      courseTitle: course.title,
      amount: result.amount,
    })
  );

  return redirect("/settings");
}
