import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
} from "~/db/schema";

// ─── Refund Requests ───
// One place that holds every rule about a learner getting their money back:
// whether a purchase can be refunded (and why not), and raising the Refund
// Request. Routes and pages call this and hold no refund rules of their own.
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
  | "team_seat_claimed"
  | "window_closed"
  | "watched_too_much"
  | "completed_too_much"
  | "warning_not_acknowledged";

const REFUSAL_MESSAGES: Record<RefundRefusalReason, string> = {
  no_purchase: "You have not bought this course.",
  request_undecided:
    "You already have an open refund request on this purchase.",
  team_seat_claimed: "A claimed team seat cannot be refunded.",
  window_closed: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
  watched_too_much:
    "You have watched too much of this course to request a refund.",
  completed_too_much:
    "You have completed too much of this course to request a refund.",
  warning_not_acknowledged:
    "Confirm that you understand what requesting a refund does before sending it.",
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

function hasUndecidedRefundRequest(purchaseId: number) {
  const open = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .get();

  return !!open;
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
