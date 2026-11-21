import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  comments,
  coupons,
  courseRatings,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAnswers,
  quizAttempts,
  quizzes,
  refunds,
  users,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
  UserRole,
} from "~/db/schema";

// ─── Refund Requests ───
// One place that holds every rule about a learner getting their money back:
// whether a purchase can be refunded (and why not), raising the Refund
// Request, the team approving or declining it, marking the Refund as issued
// (which ends access and erases Progress), and whether any of that has the
// course Locked. Routes and pages call this and hold no refund rules of their
// own.
// Vocabulary is in GLOSSARY.md; the decisions are in docs/adr/0001.
//
// Nothing here throws for a refused request — callers get the reason back and
// decide how to show it.
//
// Uses positional parameters (project convention).

const REFUND_WINDOW_DAYS = 14;
const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
/** Share of the course's lessons completed at which a Refund is off the table. */
const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundRequest = typeof refunds.$inferSelect;

/** Why a purchase can't be refunded. */
export type RefundRefusalReason =
  | "no_purchase"
  | "request_undecided"
  | "already_refunded"
  | "team_seat_claimed"
  | "window_closed"
  | "watched_too_much"
  | "completed_too_much"
  | "warning_not_acknowledged"
  | "request_not_found"
  | "request_not_open";

const REFUSAL_MESSAGES: Record<RefundRefusalReason, string> = {
  no_purchase: "You have not bought this course.",
  request_undecided:
    "You already have a refund request on this purchase that is open or approved.",
  already_refunded: "This purchase has already been refunded.",
  team_seat_claimed: "A claimed team seat cannot be refunded.",
  window_closed: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
  watched_too_much:
    "You have watched too much of this course to request a refund.",
  completed_too_much:
    "You have completed too much of this course to request a refund.",
  warning_not_acknowledged:
    "Confirm that you understand what requesting a refund does before sending it.",
  request_not_found: "We couldn't find that refund request.",
  request_not_open: "Only an open refund request can be withdrawn.",
};

export type RefundRefusal = {
  reason: RefundRefusalReason;
  /** The reason in words the learner can be shown. */
  message: string;
};

export type RefundEligibility =
  | {
      eligible: true;
      purchaseId: number;
      /** A Refund is always the full amount paid. */
      amount: number;
    }
  | ({ eligible: false } & RefundRefusal);

export type RaiseRefundRequestResult =
  | { raised: true; refundRequest: RefundRequest; amount: number }
  | ({ raised: false } & RefundRefusal);

function refusal(reason: RefundRefusalReason): RefundRefusal {
  return { reason, message: REFUSAL_MESSAGES[reason] };
}

/**
 * The learner's latest purchase of this course. A learner can have more than
 * one, and every refund rule — and the access resolver — reads the latest.
 */
export function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(desc(purchases.createdAt), desc(purchases.id))
    .get();
}

/**
 * The Refund Request that has this course Locked for the learner, or null
 * when it isn't Locked. Locked is derived, never stored: the learner's latest
 * purchase has a Refund Request that is Open, or approved with the Refund not
 * yet issued (a Pending Refund).
 */
export function getLockingRefundRequest(
  userId: number,
  courseId: number
): RefundRequest | null {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) return null;

  const locking = db
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchase.id),
        or(
          eq(refunds.status, RefundStatus.Open),
          and(
            eq(refunds.status, RefundStatus.Approved),
            isNull(refunds.issuedAt)
          )
        )
      )
    )
    .orderBy(desc(refunds.id))
    .get();

  return locking ?? null;
}

/** Is this course Locked for the learner? */
export function isCourseLocked(userId: number, courseId: number): boolean {
  return getLockingRefundRequest(userId, courseId) !== null;
}

// Only one Refund Request per purchase can be in play at once: an Open one,
// or an approved one whose Refund hasn't been issued yet (a Pending Refund).
// A Declined or Withdrawn request leaves the learner free to ask again.
function hasUndecidedRefundRequest(purchaseId: number) {
  const undecided = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        or(
          eq(refunds.status, RefundStatus.Open),
          and(
            eq(refunds.status, RefundStatus.Approved),
            isNull(refunds.issuedAt)
          )
        )
      )
    )
    .get();

  return !!undecided;
}

// One Refund per purchase: once its Refund is issued, the purchase is spent.
function hasIssuedRefund(purchaseId: number) {
  const issued = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Approved),
        isNotNull(refunds.issuedAt)
      )
    )
    .get();

  return !!issued;
}

// A seat that came out of a team licence, and has been claimed, belongs to
// the team — the buyer cannot hand it back on their own.
function hasClaimedTeamSeat(purchaseId: number) {
  const claimedSeat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();

  return !!claimedSeat;
}

// The fourteen-day window is counted in whole days, not hours — someone who
// buys at 23:00 should still get the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function isWithinRefundWindow(purchasedAtIso: string) {
  const lastDay = new Date(purchasedAtIso);
  lastDay.setDate(lastDay.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(new Date()) <= calendarDay(lastDay);
}

function getCourseLessonIds(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

// Watched time is the furthest point reached in each lesson, added up —
// rewatching the same minute doesn't count twice.
function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

/**
 * Can the learner's latest purchase of this course be refunded, and if not,
 * why? The first rule that fails is the reason given.
 */
export function getRefundEligibility(
  userId: number,
  courseId: number
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);

  if (!purchase) {
    return { eligible: false, ...refusal("no_purchase") };
  }

  if (hasUndecidedRefundRequest(purchase.id)) {
    return { eligible: false, ...refusal("request_undecided") };
  }

  if (hasIssuedRefund(purchase.id)) {
    return { eligible: false, ...refusal("already_refunded") };
  }

  if (hasClaimedTeamSeat(purchase.id)) {
    return { eligible: false, ...refusal("team_seat_claimed") };
  }

  if (!isWithinRefundWindow(purchase.createdAt)) {
    return { eligible: false, ...refusal("window_closed") };
  }

  const lessonIds = getCourseLessonIds(courseId);

  if (getSecondsWatched(userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
    return { eligible: false, ...refusal("watched_too_much") };
  }

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(userId, lessonIds) / lessonIds.length >=
      REFUND_COMPLETION_LIMIT
  ) {
    return { eligible: false, ...refusal("completed_too_much") };
  }

  return {
    eligible: true,
    purchaseId: purchase.id,
    amount: purchase.amountPaid,
  };
}

/**
 * Raises an Open Refund Request on the learner's latest purchase of this
 * course, or refuses with the reason the purchase can't be refunded. Raising
 * it locks the course, so the learner must have confirmed the warning that
 * says so (`warningAcknowledged`).
 */
export function raiseRefundRequest(
  userId: number,
  courseId: number,
  reason: string,
  warningAcknowledged: boolean
): RaiseRefundRequestResult {
  const eligibility = getRefundEligibility(userId, courseId);

  if (!eligibility.eligible) {
    return {
      raised: false,
      reason: eligibility.reason,
      message: eligibility.message,
    };
  }

  if (!warningAcknowledged) {
    return { raised: false, ...refusal("warning_not_acknowledged") };
  }

  const refundRequest = db
    .insert(refunds)
    .values({
      purchaseId: eligibility.purchaseId,
      status: RefundStatus.Open,
      reason,
    })
    .returning()
    .get();

  return { raised: true, refundRequest, amount: eligibility.amount };
}

// ─── The team's decision ───
// "The team" is admins. Instructors have no part in deciding Refunds.

/** A Refund Request as the team sees it: who, which course, and how far in. */
export type RefundRequestDetails = RefundRequest & {
  learner: { id: number; name: string; email: string };
  course: { id: number; title: string; slug: string };
  /** What the learner paid — and so what the Refund is, if approved. */
  amountPaid: number;
  /** The admin who approved or declined it; null while undecided. */
  resolvedBy: { id: number; name: string } | null;
  lessonsCompleted: number;
  lessonCount: number;
  secondsWatched: number;
};

/** Why a Refund Request can't be approved or declined. */
export type RefundDecisionRefusalReason =
  | "not_admin"
  | "request_not_found"
  | "request_not_open";

const DECISION_REFUSAL_MESSAGES: Record<RefundDecisionRefusalReason, string> = {
  not_admin: "Only admins can decide refund requests.",
  request_not_found: "That refund request does not exist.",
  request_not_open: "Only an open refund request can be approved or declined.",
};

export type RefundDecisionResult =
  | { decided: true; refundRequest: RefundRequestDetails }
  | {
      decided: false;
      reason: RefundDecisionRefusalReason;
      /** The reason in words the admin can be shown. */
      message: string;
    };

function decisionRefusal(
  reason: RefundDecisionRefusalReason
): RefundDecisionResult {
  return { decided: false, reason, message: DECISION_REFUSAL_MESSAGES[reason] };
}

/** May this user see and decide Refund Requests? Admins only. */
export function canDecideRefundRequests(userId: number): boolean {
  const user = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  return user?.role === UserRole.Admin;
}

function withDetails(
  rows: {
    refundRequest: RefundRequest;
    purchase: typeof purchases.$inferSelect;
  }[]
): RefundRequestDetails[] {
  return rows.map(({ refundRequest, purchase }) => {
    const learner = db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, purchase.userId))
      .get()!;
    const course = db
      .select({ id: courses.id, title: courses.title, slug: courses.slug })
      .from(courses)
      .where(eq(courses.id, purchase.courseId))
      .get()!;
    const resolvedBy = refundRequest.resolvedByUserId
      ? (db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, refundRequest.resolvedByUserId))
          .get() ?? null)
      : null;
    const lessonIds = getCourseLessonIds(course.id);

    return {
      ...refundRequest,
      learner,
      course,
      amountPaid: purchase.amountPaid,
      resolvedBy,
      lessonsCompleted: getCompletedLessonCount(learner.id, lessonIds),
      lessonCount: lessonIds.length,
      secondsWatched: getSecondsWatched(learner.id, lessonIds),
    };
  });
}

function getRefundRequestDetails(
  refundRequestId: number
): RefundRequestDetails | null {
  const rows = db
    .select({ refundRequest: refunds, purchase: purchases })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(eq(refunds.id, refundRequestId))
    .all();

  return withDetails(rows)[0] ?? null;
}

function decideRefundRequest(
  refundRequestId: number,
  adminUserId: number,
  status: RefundStatus.Approved | RefundStatus.Declined
): RefundDecisionResult {
  if (!canDecideRefundRequests(adminUserId)) {
    return decisionRefusal("not_admin");
  }

  const current = getRefundRequestDetails(refundRequestId);
  if (!current) return decisionRefusal("request_not_found");

  // The status is checked in the update itself, so two admins deciding at
  // once can't both succeed.
  const decided = db
    .update(refunds)
    .set({
      status,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: adminUserId,
      // A Refund is always the full amount paid; a declined request has none.
      amountRefunded:
        status === RefundStatus.Approved ? current.amountPaid : null,
    })
    .where(
      and(eq(refunds.id, refundRequestId), eq(refunds.status, RefundStatus.Open))
    )
    .returning()
    .get();

  if (!decided) return decisionRefusal("request_not_open");

  return {
    decided: true,
    refundRequest: getRefundRequestDetails(refundRequestId)!,
  };
}

/**
 * An admin turns an Open Refund Request down. It becomes a Declined Refund
 * Request with no Refund: the course unlocks with Progress as it was, and the
 * learner may raise a new one under the usual limits.
 */
export function declineRefundRequest(
  refundRequestId: number,
  adminUserId: number
): RefundDecisionResult {
  return decideRefundRequest(
    refundRequestId,
    adminUserId,
    RefundStatus.Declined
  );
}

/**
 * An admin accepts an Open Refund Request. It becomes an Approved Refund
 * Request with a Pending Refund for the full amount paid. Nothing else
 * changes yet: the course stays Locked and Progress stays untouched until the
 * Refund is issued.
 */
export function approveRefundRequest(
  refundRequestId: number,
  adminUserId: number
): RefundDecisionResult {
  return decideRefundRequest(
    refundRequestId,
    adminUserId,
    RefundStatus.Approved
  );
}

// ─── Issuing the Refund ───
// Marking a Pending Refund as issued is the moment the learner stops having
// the course (ADR 0001). It can't be undone, and support can't restore what it
// erases.

/** Why a Refund can't be marked as issued. */
export type MarkRefundIssuedRefusalReason =
  | "not_admin"
  | "request_not_found"
  | "request_not_approved"
  | "refund_already_issued";

const ISSUE_REFUSAL_MESSAGES: Record<MarkRefundIssuedRefusalReason, string> = {
  not_admin: "Only admins can mark a refund as issued.",
  request_not_found: "That refund request does not exist.",
  request_not_approved:
    "Only an approved refund request can have its refund marked as issued.",
  refund_already_issued: "That refund has already been marked as issued.",
};

export type MarkRefundIssuedResult =
  | { issued: true; refundRequest: RefundRequestDetails }
  | {
      issued: false;
      reason: MarkRefundIssuedRefusalReason;
      /** The reason in words the admin can be shown. */
      message: string;
    };

function issueRefusal(
  reason: MarkRefundIssuedRefusalReason
): MarkRefundIssuedResult {
  return { issued: false, reason, message: ISSUE_REFUSAL_MESSAGES[reason] };
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Progress is everything the learner built up in this one course (see
// GLOSSARY.md). All of it is deleted outright except comments, which use the
// existing deleted-comment state with their content removed, so other
// learners' replies to them stay readable.
function eraseProgress(tx: Transaction, userId: number, courseId: number) {
  tx.delete(courseRatings)
    .where(
      and(eq(courseRatings.userId, userId), eq(courseRatings.courseId, courseId))
    )
    .run();

  const lessonIds = tx
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
  if (lessonIds.length === 0) return;

  tx.delete(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .run();

  tx.delete(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .run();

  const attemptIds = tx
    .select({ id: quizAttempts.id })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .where(
      and(eq(quizAttempts.userId, userId), inArray(quizzes.lessonId, lessonIds))
    )
    .all()
    .map((row) => row.id);
  if (attemptIds.length > 0) {
    tx.delete(quizAnswers)
      .where(inArray(quizAnswers.attemptId, attemptIds))
      .run();
    tx.delete(quizAttempts).where(inArray(quizAttempts.id, attemptIds)).run();
  }

  // A comment the learner had already deleted keeps the moment they did.
  const now = new Date().toISOString();
  tx.update(comments)
    .set({
      body: "",
      editedAt: null,
      deletedAt: sql`coalesce(${comments.deletedAt}, ${now})`,
    })
    .where(
      and(eq(comments.userId, userId), inArray(comments.lessonId, lessonIds))
    )
    .run();
}

/**
 * An admin confirms the money of a Pending Refund has been sent, making it an
 * Issued Refund. In one transaction this records the moment and the admin,
 * ends the learner's enrollment in the course, and erases their Progress in
 * it — all of it or none of it. Nothing in any other course is touched, and
 * the purchase and the Refund Request stay as the record.
 *
 * Refused unless the Refund Request is approved and its Refund not yet
 * issued. Unlike a refusal, a failure partway through throws, and leaves
 * access and Progress as they were.
 */
export function markRefundIssued(
  refundRequestId: number,
  adminUserId: number
): MarkRefundIssuedResult {
  if (!canDecideRefundRequests(adminUserId)) {
    return issueRefusal("not_admin");
  }

  const current = getRefundRequestDetails(refundRequestId);
  if (!current) return issueRefusal("request_not_found");
  if (current.status !== RefundStatus.Approved) {
    return issueRefusal("request_not_approved");
  }

  const issued = db.transaction((tx) => {
    // Pending is checked in the update itself, so two admins marking it at
    // once can't both succeed.
    const marked = tx
      .update(refunds)
      .set({
        issuedAt: new Date().toISOString(),
        issuedByUserId: adminUserId,
      })
      .where(
        and(
          eq(refunds.id, refundRequestId),
          eq(refunds.status, RefundStatus.Approved),
          isNull(refunds.issuedAt)
        )
      )
      .returning({ id: refunds.id })
      .get();
    if (!marked) return false;

    tx.delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, current.learner.id),
          eq(enrollments.courseId, current.course.id)
        )
      )
      .run();
    eraseProgress(tx, current.learner.id, current.course.id);

    return true;
  });

  if (!issued) return issueRefusal("refund_already_issued");

  return {
    issued: true,
    refundRequest: getRefundRequestDetails(refundRequestId)!,
  };
}

/**
 * Every Refund Request, newest first, as the team sees them. Callers gate
 * this with `canDecideRefundRequests`.
 */
export function listRefundRequests(): RefundRequestDetails[] {
  const rows = db
    .select({ refundRequest: refunds, purchase: purchases })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .orderBy(desc(refunds.requestedAt), desc(refunds.id))
    .all();

  return withDetails(rows);
}

// ─── The learner's own Refund Requests ───

export type WithdrawRefundRequestResult =
  | { withdrawn: true; refundRequest: RefundRequest }
  | ({ withdrawn: false } & RefundRefusal);

/**
 * Withdraws the learner's Open Refund Request, which unlocks the course at
 * once with Progress as they left it. Only the learner who raised it can; to
 * anyone else the request doesn't exist.
 */
export function withdrawRefundRequest(
  userId: number,
  refundRequestId: number
): WithdrawRefundRequestResult {
  const own = db
    .select({ status: refunds.status })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(and(eq(refunds.id, refundRequestId), eq(purchases.userId, userId)))
    .get();

  if (!own) {
    return { withdrawn: false, ...refusal("request_not_found") };
  }

  // No withdrawing once the team has decided, and nothing to withdraw twice.
  if (own.status !== RefundStatus.Open) {
    return { withdrawn: false, ...refusal("request_not_open") };
  }

  const refundRequest = db
    .update(refunds)
    .set({ status: RefundStatus.Withdrawn })
    .where(eq(refunds.id, refundRequestId))
    .returning()
    .get();

  return { withdrawn: true, refundRequest };
}

/**
 * Every Refund Request the learner has raised, newest first, with what it was
 * for and the state it is in. `refundIssued` tells a Pending Refund (approved,
 * money not yet confirmed as sent) from an Issued Refund.
 */
export function listLearnerRefundRequests(userId: number) {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      refundIssued: sql<number>`${refunds.issuedAt} is not null`.mapWith(
        Boolean
      ),
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      amountPaid: purchases.amountPaid,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.userId, userId))
    .orderBy(desc(refunds.requestedAt), desc(refunds.id))
    .all();
}

export type LearnerRefundRequest = ReturnType<
  typeof listLearnerRefundRequests
>[number];
