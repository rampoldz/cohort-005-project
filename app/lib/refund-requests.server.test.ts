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
  getRefundEligibility,
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

      const result = raiseRefundRequest(world.user.id, world.course.id, REASON);

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
      raiseRefundRequest(world.user.id, world.course.id, REASON);

      expect(getRefundEligibility(world.user.id, world.course.id)).toEqual({
        eligible: false,
        reason: "request_undecided",
        message: "You already have an open refund request on this purchase.",
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

      const result = raiseRefundRequest(world.user.id, world.course.id, REASON);

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

    it("refuses a second Refund Request while the first is undecided", () => {
      buyCourse(world);
      raiseRefundRequest(world.user.id, world.course.id, REASON);

      const second = raiseRefundRequest(world.user.id, world.course.id, REASON);

      expect(second).toMatchObject({
        raised: false,
        reason: "request_undecided",
      });
    });
  });
});
