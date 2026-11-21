import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

// The module under test talks to `~/db`. Point that at a fresh in-memory
// database, built from the real migrations, for every test.
let testDb: ReturnType<typeof createTestDb>;
vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  approveRefundRequest,
  canDecideRefundRequests,
  declineRefundRequest,
  listRefundRequests,
  getLockingRefundRequest,
  getRefundEligibility,
  isCourseLocked,
  raiseRefundRequest,
} from "./refund-requests.server";

// Midday, so "days ago" never straddles midnight in any timezone the tests
// run in.
const NOW = new Date(2026, 5, 20, 12, 0, 0);

function daysAgo(days: number, hour = 12): string {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  when.setHours(hour, 0, 0, 0);
  return when.toISOString();
}

const REASON = "Bought the wrong one, I meant the advanced course.";

type World = ReturnType<typeof seedBaseData> & { lessonIds: number[] };

/** A learner, and a course with ten lessons they have not bought yet. */
function seedWorld(): World {
  const base = seedBaseData(testDb);
  const courseModule = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get();
  const lessonIds = Array.from({ length: 10 }, (_, i) =>
    testDb
      .insert(schema.lessons)
      .values({
        moduleId: courseModule.id,
        title: `Lesson ${i + 1}`,
        position: i + 1,
      })
      .returning()
      .get()
  ).map((lesson) => lesson.id);

  return { ...base, lessonIds };
}

function buyCourse(world: World, boughtAt: string = daysAgo(3)) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: world.user.id,
      courseId: world.course.id,
      amountPaid: 7900,
      createdAt: boughtAt,
    })
    .returning()
    .get();
  testDb
    .insert(schema.enrollments)
    .values({
      userId: world.user.id,
      courseId: world.course.id,
      enrolledAt: boughtAt,
    })
    .run();
  return purchase;
}

function completeLessons(world: World, count: number) {
  for (const lessonId of world.lessonIds.slice(0, count)) {
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: world.user.id,
        lessonId,
        status: schema.LessonProgressStatus.Completed,
        completedAt: daysAgo(1),
      })
      .run();
  }
}

function watch(world: World, lessonIndex: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: world.user.id,
      lessonId: world.lessonIds[lessonIndex],
      eventType: "progress",
      positionSeconds,
    })
    .run();
}

/** Turns the purchase into a team purchase with one seat, claimed or not. */
function addTeamSeat(world: World, purchaseId: number, claimed: boolean) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  testDb
    .insert(schema.coupons)
    .values({
      teamId: team.id,
      courseId: world.course.id,
      code: "TEAM-SEAT-1",
      purchaseId,
      redeemedByUserId: claimed ? world.instructor.id : null,
      redeemedAt: claimed ? daysAgo(1) : null,
    })
    .run();
}

describe("Refund Request module", () => {
  let world: World;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    testDb = createTestDb();
    world = seedWorld();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("raising a Refund Request", () => {
    it("offers a Refund of the full amount paid on a fresh purchase", () => {
      buyCourse(world, daysAgo(3));

      const eligibility = getRefundEligibility(world.user.id, world.course.id);

      expect(eligibility).toMatchObject({ eligible: true, amount: 7900 });
    });

    it("raises an Open Refund Request with the learner's reason", () => {
      const purchase = buyCourse(world);

      const result = raiseRefundRequest(world.user.id, world.course.id, REASON, true);

      expect(result).toMatchObject({
        raised: true,
        amount: 7900,
        refundRequest: {
          purchaseId: purchase.id,
          status: schema.RefundStatus.Open,
          reason: REASON,
        },
      });
    });
  });

  describe("a Locked course", () => {
    /** Puts a Refund Request on the purchase in a state nothing can reach yet. */
    function addRefundRequest(
      purchaseId: number,
      values: Partial<typeof schema.refunds.$inferInsert>
    ) {
      return testDb
        .insert(schema.refunds)
        .values({ purchaseId, reason: REASON, ...values })
        .returning()
        .get();
    }

    it("is not Locked for a learner who has only bought the course", () => {
      buyCourse(world);

      expect(isCourseLocked(world.user.id, world.course.id)).toBe(false);
      expect(getLockingRefundRequest(world.user.id, world.course.id)).toBeNull();
    });

    it("is not Locked for someone who has not bought the course", () => {
      expect(isCourseLocked(world.user.id, world.course.id)).toBe(false);
    });

    it("is Locked from the moment a Refund Request is raised", () => {
      buyCourse(world);

      const result = raiseRefundRequest(
        world.user.id,
        world.course.id,
        REASON,
        true
      );

      expect(isCourseLocked(world.user.id, world.course.id)).toBe(true);
      expect(
        getLockingRefundRequest(world.user.id, world.course.id)
      ).toMatchObject({
        id: result.raised ? result.refundRequest.id : undefined,
        status: schema.RefundStatus.Open,
      });
    });

    it("leaves the learner's Progress untouched when a Refund Request is raised", () => {
      buyCourse(world);
      completeLessons(world, 3);
      watch(world, 0, 600);
      // No interface reports Progress yet, so this one reads the tables.
      const progressBefore = testDb.select().from(schema.lessonProgress).all();
      const watchedBefore = testDb.select().from(schema.videoWatchEvents).all();

      raiseRefundRequest(world.user.id, world.course.id, REASON, true);

      expect(testDb.select().from(schema.lessonProgress).all()).toEqual(
        progressBefore
      );
      expect(testDb.select().from(schema.videoWatchEvents).all()).toEqual(
        watchedBefore
      );
      expect(progressBefore).toHaveLength(3);
    });

    it("stays unlocked when the Refund Request is refused", () => {
      buyCourse(world);

      raiseRefundRequest(world.user.id, world.course.id, REASON, false);

      expect(isCourseLocked(world.user.id, world.course.id)).toBe(false);
    });

    it("is Locked while the Refund Request is approved and the Refund not yet issued", () => {
      const purchase = buyCourse(world);
      addRefundRequest(purchase.id, {
        status: schema.RefundStatus.Approved,
        amountRefunded: 7900,
        resolvedAt: daysAgo(1),
      });

      expect(isCourseLocked(world.user.id, world.course.id)).toBe(true);
      expect(
        getLockingRefundRequest(world.user.id, world.course.id)
      ).toMatchObject({ status: schema.RefundStatus.Approved });
    });

    it("is not Locked by a declined or withdrawn Refund Request", () => {
      const purchase = buyCourse(world);
      addRefundRequest(purchase.id, {
        status: schema.RefundStatus.Declined,
        resolvedAt: daysAgo(2),
      });
      addRefundRequest(purchase.id, { status: schema.RefundStatus.Withdrawn });

      expect(isCourseLocked(world.user.id, world.course.id)).toBe(false);
    });

    it("is not Locked once the Refund is issued", () => {
      const purchase = buyCourse(world);
      addRefundRequest(purchase.id, {
        status: schema.RefundStatus.Approved,
        amountRefunded: 7900,
        resolvedAt: daysAgo(2),
        issuedAt: daysAgo(1),
      });

      expect(isCourseLocked(world.user.id, world.course.id)).toBe(false);
    });

    it("is decided by the learner's latest purchase of the course", () => {
      const earlier = buyCourse(world, daysAgo(40));
      addRefundRequest(earlier.id, { status: schema.RefundStatus.Open });
      testDb
        .insert(schema.purchases)
        .values({
          userId: world.user.id,
          courseId: world.course.id,
          amountPaid: 7900,
          createdAt: daysAgo(2),
        })
        .run();

      expect(isCourseLocked(world.user.id, world.course.id)).toBe(false);
    });

    it("locks only the course the Refund Request is for, and only for that learner", () => {
      buyCourse(world);
      const otherCourse = testDb
        .insert(schema.courses)
        .values({
          title: "Other Course",
          slug: "other-course",
          description: "Another course",
          salesCopy: "Sales copy",
          instructorId: world.instructor.id,
          categoryId: world.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();
      testDb
        .insert(schema.purchases)
        .values({
          userId: world.user.id,
          courseId: otherCourse.id,
          amountPaid: 4900,
          createdAt: daysAgo(3),
        })
        .run();

      raiseRefundRequest(world.user.id, world.course.id, REASON, true);

      expect(isCourseLocked(world.user.id, otherCourse.id)).toBe(false);
      expect(isCourseLocked(world.instructor.id, world.course.id)).toBe(false);
    });
  });

  describe("deciding a Refund Request", () => {
    function addAdmin() {
      return testDb
        .insert(schema.users)
        .values({
          name: "Ada Admin",
          email: "ada@example.com",
          role: schema.UserRole.Admin,
        })
        .returning()
        .get();
    }

    /** The learner buys the course and raises a Refund Request on it. */
    function raiseOpenRequest() {
      buyCourse(world);
      const result = raiseRefundRequest(
        world.user.id,
        world.course.id,
        REASON,
        true
      );
      if (!result.raised) throw new Error("The Refund Request was refused");
      return result.refundRequest;
    }

    describe("declining", () => {
      it("makes it a Declined Refund Request, recording the admin and the moment", () => {
        const admin = addAdmin();
        const request = raiseOpenRequest();

        const result = declineRefundRequest(request.id, admin.id);

        expect(result).toMatchObject({
          decided: true,
          refundRequest: {
            id: request.id,
            status: schema.RefundStatus.Declined,
            resolvedAt: NOW.toISOString(),
            resolvedBy: { id: admin.id, name: "Ada Admin" },
            amountRefunded: null,
          },
        });
      });

      it("unlocks the course", () => {
        const admin = addAdmin();
        const request = raiseOpenRequest();

        declineRefundRequest(request.id, admin.id);

        expect(isCourseLocked(world.user.id, world.course.id)).toBe(false);
      });

      it("leaves the learner free to raise a new Refund Request", () => {
        const admin = addAdmin();
        const request = raiseOpenRequest();

        declineRefundRequest(request.id, admin.id);

        expect(
          getRefundEligibility(world.user.id, world.course.id)
        ).toMatchObject({ eligible: true, amount: 7900 });
        expect(
          raiseRefundRequest(world.user.id, world.course.id, REASON, true)
        ).toMatchObject({
          raised: true,
          refundRequest: { status: schema.RefundStatus.Open },
        });
      });

      it("still holds a learner who asks again to the usual limits", () => {
        const admin = addAdmin();
        const request = raiseOpenRequest();
        declineRefundRequest(request.id, admin.id);

        // Back in the course, they finish half of it.
        completeLessons(world, 5);

        expect(
          raiseRefundRequest(world.user.id, world.course.id, REASON, true)
        ).toMatchObject({ raised: false, reason: "completed_too_much" });
      });

      it("is refused to the course's instructor, and the request stays Open", () => {
        const request = raiseOpenRequest();

        const result = declineRefundRequest(request.id, world.instructor.id);

        expect(result).toEqual({
          decided: false,
          reason: "not_admin",
          message: "Only admins can decide refund requests.",
        });
        expect(
          getLockingRefundRequest(world.user.id, world.course.id)
        ).toMatchObject({ status: schema.RefundStatus.Open });
      });

      it("is refused to the learner who raised it", () => {
        const request = raiseOpenRequest();

        expect(declineRefundRequest(request.id, world.user.id)).toMatchObject({
          decided: false,
          reason: "not_admin",
        });
        expect(isCourseLocked(world.user.id, world.course.id)).toBe(true);
      });

      it("is refused for a Refund Request that doesn't exist", () => {
        const admin = addAdmin();

        expect(declineRefundRequest(999, admin.id)).toEqual({
          decided: false,
          reason: "request_not_found",
          message: "That refund request does not exist.",
        });
      });

      it("is refused once the Refund Request has been declined", () => {
        const admin = addAdmin();
        const request = raiseOpenRequest();
        declineRefundRequest(request.id, admin.id);

        expect(declineRefundRequest(request.id, admin.id)).toEqual({
          decided: false,
          reason: "request_not_open",
          message:
            "Only an open refund request can be approved or declined.",
        });
      });
    });

    describe("approving", () => {
      it("makes it an Approved Refund Request with a Refund of the full amount paid", () => {
        const admin = addAdmin();
        const request = raiseOpenRequest();

        const result = approveRefundRequest(request.id, admin.id);

        expect(result).toMatchObject({
          decided: true,
          refundRequest: {
            id: request.id,
            status: schema.RefundStatus.Approved,
            amountPaid: 7900,
            amountRefunded: 7900,
            resolvedAt: NOW.toISOString(),
            resolvedBy: { id: admin.id, name: "Ada Admin" },
            // A Pending Refund: approved, the money not yet confirmed as sent.
            issuedAt: null,
          },
        });
      });

      it("keeps the course Locked", () => {
        const admin = addAdmin();
        const request = raiseOpenRequest();

        approveRefundRequest(request.id, admin.id);

        expect(
          getLockingRefundRequest(world.user.id, world.course.id)
        ).toMatchObject({
          id: request.id,
          status: schema.RefundStatus.Approved,
        });
      });

      it("leaves no room for another Refund Request on the purchase", () => {
        const admin = addAdmin();
        const request = raiseOpenRequest();

        approveRefundRequest(request.id, admin.id);

        expect(
          raiseRefundRequest(world.user.id, world.course.id, REASON, true)
        ).toMatchObject({ raised: false, reason: "request_undecided" });
      });

      it("is refused to the course's instructor and to the learner", () => {
        const request = raiseOpenRequest();

        expect(
          approveRefundRequest(request.id, world.instructor.id)
        ).toMatchObject({ decided: false, reason: "not_admin" });
        expect(approveRefundRequest(request.id, world.user.id)).toMatchObject({
          decided: false,
          reason: "not_admin",
        });
        expect(
          getLockingRefundRequest(world.user.id, world.course.id)
        ).toMatchObject({ status: schema.RefundStatus.Open });
      });

      it("is refused once the Refund Request has been declined", () => {
        const admin = addAdmin();
        const request = raiseOpenRequest();
        declineRefundRequest(request.id, admin.id);

        expect(approveRefundRequest(request.id, admin.id)).toMatchObject({
          decided: false,
          reason: "request_not_open",
        });
        expect(isCourseLocked(world.user.id, world.course.id)).toBe(false);
      });

      it("can't be undone by declining afterwards", () => {
        const admin = addAdmin();
        const request = raiseOpenRequest();
        approveRefundRequest(request.id, admin.id);

        expect(declineRefundRequest(request.id, admin.id)).toMatchObject({
          decided: false,
          reason: "request_not_open",
        });
        expect(isCourseLocked(world.user.id, world.course.id)).toBe(true);
      });

      it("is refused for a Refund Request the learner withdrew", () => {
        const admin = addAdmin();
        const purchase = buyCourse(world);
        // Withdrawing isn't built yet, so the row is put there directly.
        const withdrawn = testDb
          .insert(schema.refunds)
          .values({
            purchaseId: purchase.id,
            reason: REASON,
            status: schema.RefundStatus.Withdrawn,
          })
          .returning()
          .get();

        expect(approveRefundRequest(withdrawn.id, admin.id)).toMatchObject({
          decided: false,
          reason: "request_not_open",
        });
      });
    });

    describe("what the team sees", () => {
      it("lets only admins see and decide Refund Requests", () => {
        const admin = addAdmin();

        expect(canDecideRefundRequests(admin.id)).toBe(true);
        expect(canDecideRefundRequests(world.instructor.id)).toBe(false);
        expect(canDecideRefundRequests(world.user.id)).toBe(false);
      });

      it("lists an Open Refund Request with the learner, course, amount, reason, date and how far in they are", () => {
        buyCourse(world);
        completeLessons(world, 3);
        watch(world, 0, 600);
        watch(world, 1, 300);
        raiseRefundRequest(world.user.id, world.course.id, REASON, true);

        expect(listRefundRequests()).toMatchObject([
          {
            status: schema.RefundStatus.Open,
            learner: { name: "Test User", email: "test@example.com" },
            course: { title: "Test Course", slug: "test-course" },
            amountPaid: 7900,
            reason: REASON,
            requestedAt: NOW.toISOString(),
            lessonsCompleted: 3,
            lessonCount: 10,
            secondsWatched: 900,
            resolvedBy: null,
          },
        ]);
      });

      it("lists past Refund Requests with their outcomes, newest first", () => {
        const admin = addAdmin();
        const first = raiseOpenRequest();
        declineRefundRequest(first.id, admin.id);
        const second = raiseRefundRequest(
          world.user.id,
          world.course.id,
          REASON,
          true
        );
        if (!second.raised) throw new Error("The Refund Request was refused");
        approveRefundRequest(second.refundRequest.id, admin.id);

        expect(listRefundRequests()).toMatchObject([
          {
            id: second.refundRequest.id,
            status: schema.RefundStatus.Approved,
            amountRefunded: 7900,
            resolvedBy: { name: "Ada Admin" },
          },
          {
            id: first.id,
            status: schema.RefundStatus.Declined,
            amountRefunded: null,
            resolvedBy: { name: "Ada Admin" },
          },
        ]);
      });

      it("shows the learner's Progress untouched by a decline", () => {
        const admin = addAdmin();
        buyCourse(world);
        completeLessons(world, 3);
        watch(world, 0, 600);
        const raised = raiseRefundRequest(
          world.user.id,
          world.course.id,
          REASON,
          true
        );
        if (!raised.raised) throw new Error("The Refund Request was refused");

        declineRefundRequest(raised.refundRequest.id, admin.id);

        expect(listRefundRequests()).toMatchObject([
          { lessonsCompleted: 3, secondsWatched: 600 },
        ]);
      });

      it("shows the learner's Progress untouched by an approval", () => {
        const admin = addAdmin();
        buyCourse(world);
        completeLessons(world, 3);
        watch(world, 0, 600);
        const raised = raiseRefundRequest(
          world.user.id,
          world.course.id,
          REASON,
          true
        );
        if (!raised.raised) throw new Error("The Refund Request was refused");

        approveRefundRequest(raised.refundRequest.id, admin.id);

        expect(listRefundRequests()).toMatchObject([
          { lessonsCompleted: 3, secondsWatched: 600 },
        ]);
      });
    });
  });

  describe("why a purchase can't be refunded", () => {
    it("refuses a learner who has not bought the course", () => {
      expect(getRefundEligibility(world.user.id, world.course.id)).toEqual({
        eligible: false,
        reason: "no_purchase",
        message: "You have not bought this course.",
      });
    });

    it("refuses while a Refund Request on the purchase is undecided", () => {
      buyCourse(world);
      raiseRefundRequest(world.user.id, world.course.id, REASON, true);

      expect(getRefundEligibility(world.user.id, world.course.id)).toEqual({
        eligible: false,
        reason: "request_undecided",
        message:
          "You already have a refund request on this purchase that is open or approved.",
      });
    });

    it("refuses while an approved Refund on the purchase has not been issued", () => {
      const purchase = buyCourse(world);
      testDb
        .insert(schema.refunds)
        .values({
          purchaseId: purchase.id,
          reason: REASON,
          status: schema.RefundStatus.Approved,
          amountRefunded: 7900,
          resolvedAt: daysAgo(1),
        })
        .run();

      expect(
        raiseRefundRequest(world.user.id, world.course.id, REASON, true)
      ).toEqual({
        raised: false,
        reason: "request_undecided",
        message:
          "You already have a refund request on this purchase that is open or approved.",
      });
    });

    it("refuses a team purchase once a seat has been claimed", () => {
      const purchase = buyCourse(world);
      addTeamSeat(world, purchase.id, true);

      expect(getRefundEligibility(world.user.id, world.course.id)).toEqual({
        eligible: false,
        reason: "team_seat_claimed",
        message: "A claimed team seat cannot be refunded.",
      });
    });

    it("allows a team purchase while no seat has been claimed", () => {
      const purchase = buyCourse(world);
      addTeamSeat(world, purchase.id, false);

      expect(getRefundEligibility(world.user.id, world.course.id)).toMatchObject(
        { eligible: true }
      );
    });

    it("allows a purchase on the last day of the 14-day window", () => {
      // Bought late in the evening: the fourteenth day still counts in full.
      buyCourse(world, daysAgo(14, 23));

      expect(getRefundEligibility(world.user.id, world.course.id)).toMatchObject(
        { eligible: true }
      );
    });

    it("refuses once the 14-day window has closed", () => {
      buyCourse(world, daysAgo(15));

      expect(getRefundEligibility(world.user.id, world.course.id)).toEqual({
        eligible: false,
        reason: "window_closed",
        message: "The 14-day window has closed.",
      });
    });

    it("allows a learner who has watched just under two hours", () => {
      buyCourse(world);
      watch(world, 0, 3600);
      watch(world, 1, 3599);

      expect(getRefundEligibility(world.user.id, world.course.id)).toMatchObject(
        { eligible: true }
      );
    });

    it("refuses a learner who has watched two hours of the course", () => {
      buyCourse(world);
      // Rewatching doesn't add up: only the furthest point in each lesson counts.
      watch(world, 0, 1200);
      watch(world, 0, 3600);
      watch(world, 1, 3600);

      expect(getRefundEligibility(world.user.id, world.course.id)).toEqual({
        eligible: false,
        reason: "watched_too_much",
        message:
          "You have watched too much of this course to request a refund.",
      });
    });

    it("allows a learner who has completed under half the lessons", () => {
      buyCourse(world);
      completeLessons(world, 4);

      expect(getRefundEligibility(world.user.id, world.course.id)).toMatchObject(
        { eligible: true }
      );
    });

    it("refuses a learner who has completed half the lessons", () => {
      buyCourse(world);
      completeLessons(world, 5);

      expect(getRefundEligibility(world.user.id, world.course.id)).toEqual({
        eligible: false,
        reason: "completed_too_much",
        message:
          "You have completed too much of this course to request a refund.",
      });
    });
  });

  describe("submitting when the purchase can't be refunded", () => {
    it("refuses a learner at the completed-lessons limit and raises nothing", () => {
      buyCourse(world);
      completeLessons(world, 5);

      const result = raiseRefundRequest(world.user.id, world.course.id, REASON, true);

      expect(result).toEqual({
        raised: false,
        reason: "completed_too_much",
        message:
          "You have completed too much of this course to request a refund.",
      });
      // Had a request been raised, the reason would now be "request_undecided".
      expect(getRefundEligibility(world.user.id, world.course.id)).toMatchObject(
        { reason: "completed_too_much" }
      );
    });

    it("refuses a learner who has not confirmed the warning and raises nothing", () => {
      buyCourse(world);

      const result = raiseRefundRequest(
        world.user.id,
        world.course.id,
        REASON,
        false
      );

      expect(result).toEqual({
        raised: false,
        reason: "warning_not_acknowledged",
        message:
          "Confirm that you understand what requesting a refund does before sending it.",
      });
      // Nothing was raised: the purchase can still be refunded.
      expect(getRefundEligibility(world.user.id, world.course.id)).toMatchObject(
        { eligible: true }
      );
    });

    it("refuses a second Refund Request while the first is undecided", () => {
      buyCourse(world);
      raiseRefundRequest(world.user.id, world.course.id, REASON, true);

      const second = raiseRefundRequest(world.user.id, world.course.id, REASON, true);

      expect(second).toMatchObject({
        raised: false,
        reason: "request_undecided",
      });
    });
  });
});
