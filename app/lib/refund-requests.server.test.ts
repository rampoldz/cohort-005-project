import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import { sql } from "drizzle-orm";
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
  isNextPurchaseFinal,
  markRefundIssued,
  isCourseLocked,
  listLearnerRefundRequests,
  raiseRefundRequest,
  withdrawRefundRequest,
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

/** The learner raises a Refund Request on the course they already bought. */
function raise(world: World) {
  const result = raiseRefundRequest(
    world.user.id,
    world.course.id,
    REASON,
    true
  );
  if (!result.raised) throw new Error("The Refund Request was refused");
  return result.refundRequest;
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
      return raise(world);
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

  describe("marking a Refund as issued", () => {
    function addUser(name: string, role = schema.UserRole.Student) {
      return testDb
        .insert(schema.users)
        .values({
          name,
          email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
          role,
        })
        .returning()
        .get();
    }

    function addAdmin() {
      return addUser("Ada Admin", schema.UserRole.Admin);
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

    /** A Pending Refund: the learner's Refund Request, approved by the admin. */
    function approveOpenRequest(adminId: number) {
      const refundRequest = raiseOpenRequest();
      const approved = approveRefundRequest(refundRequest.id, adminId);
      if (!approved.decided) throw new Error("The approval was refused");
      return refundRequest;
    }

    /** A second course by the same instructor, with two lessons. */
    function addOtherCourse() {
      const course = testDb
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
      const courseModule = testDb
        .insert(schema.modules)
        .values({ courseId: course.id, title: "Module 1", position: 1 })
        .returning()
        .get();
      const lessonIds = [1, 2].map(
        (position) =>
          testDb
            .insert(schema.lessons)
            .values({
              moduleId: courseModule.id,
              title: `Other lesson ${position}`,
              position,
            })
            .returning()
            .get().id
      );
      return { course, lessonIds };
    }

    function enroll(userId: number, courseId: number) {
      testDb.insert(schema.enrollments).values({ userId, courseId }).run();
    }

    function startLesson(userId: number, lessonId: number, completed = false) {
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId,
          lessonId,
          status: completed
            ? schema.LessonProgressStatus.Completed
            : schema.LessonProgressStatus.InProgress,
          completedAt: completed ? daysAgo(1) : null,
        })
        .run();
    }

    function watchLesson(userId: number, lessonId: number) {
      testDb
        .insert(schema.videoWatchEvents)
        .values({ userId, lessonId, eventType: "progress", positionSeconds: 90 })
        .run();
    }

    function addQuiz(lessonId: number) {
      const quiz = testDb
        .insert(schema.quizzes)
        .values({ lessonId, title: "Quiz", passingScore: 0.5 })
        .returning()
        .get();
      const question = testDb
        .insert(schema.quizQuestions)
        .values({
          quizId: quiz.id,
          questionText: "Is this a question?",
          questionType: schema.QuestionType.TrueFalse,
          position: 1,
        })
        .returning()
        .get();
      const option = testDb
        .insert(schema.quizOptions)
        .values({ questionId: question.id, optionText: "True", isCorrect: true })
        .returning()
        .get();
      return { quiz, question, option };
    }

    function attemptQuiz(userId: number, quiz: ReturnType<typeof addQuiz>) {
      const attempt = testDb
        .insert(schema.quizAttempts)
        .values({ userId, quizId: quiz.quiz.id, score: 1, passed: true })
        .returning()
        .get();
      testDb
        .insert(schema.quizAnswers)
        .values({
          attemptId: attempt.id,
          questionId: quiz.question.id,
          selectedOptionId: quiz.option.id,
        })
        .run();
    }

    function rate(userId: number, courseId: number, rating: number) {
      testDb
        .insert(schema.courseRatings)
        .values({ userId, courseId, rating })
        .run();
    }

    function comment(
      userId: number,
      lessonId: number,
      body: string,
      parentId: number | null = null
    ) {
      return testDb
        .insert(schema.comments)
        .values({ userId, lessonId, body, parentId })
        .returning()
        .get();
    }

    function getComment(commentId: number) {
      return testDb
        .select()
        .from(schema.comments)
        .all()
        .find((row) => row.id === commentId)!;
    }

    function ratingsOf(courseId: number) {
      return testDb
        .select()
        .from(schema.courseRatings)
        .all()
        .filter((row) => row.courseId === courseId)
        .map((row) => row.rating);
    }

    // Nothing in the module's interface reports quiz attempts, ratings or
    // enrollment, so what a learner has in a course is counted from the
    // tables. Comments are left out: they are never removed, only shown as
    // deleted.
    function holdingsOf(userId: number, courseId: number, lessonIds: number[]) {
      const quizIds = testDb
        .select()
        .from(schema.quizzes)
        .all()
        .filter((quiz) => lessonIds.includes(quiz.lessonId))
        .map((quiz) => quiz.id);
      const attemptIds = testDb
        .select()
        .from(schema.quizAttempts)
        .all()
        .filter(
          (attempt) =>
            attempt.userId === userId && quizIds.includes(attempt.quizId)
        )
        .map((attempt) => attempt.id);

      return {
        enrolled: testDb
          .select()
          .from(schema.enrollments)
          .all()
          .some((row) => row.userId === userId && row.courseId === courseId),
        lessonProgress: testDb
          .select()
          .from(schema.lessonProgress)
          .all()
          .filter(
            (row) => row.userId === userId && lessonIds.includes(row.lessonId)
          ).length,
        watchEvents: testDb
          .select()
          .from(schema.videoWatchEvents)
          .all()
          .filter(
            (row) => row.userId === userId && lessonIds.includes(row.lessonId)
          ).length,
        quizAttempts: attemptIds.length,
        quizAnswers: testDb
          .select()
          .from(schema.quizAnswers)
          .all()
          .filter((row) => attemptIds.includes(row.attemptId)).length,
        ratings: testDb
          .select()
          .from(schema.courseRatings)
          .all()
          .filter((row) => row.userId === userId && row.courseId === courseId)
          .length,
      };
    }

    const NOTHING = {
      enrolled: false,
      lessonProgress: 0,
      watchEvents: 0,
      quizAttempts: 0,
      quizAnswers: 0,
      ratings: 0,
    };

    /** Gives a learner one of every kind of Progress in a course. */
    function buildProgress(
      userId: number,
      courseId: number,
      lessonIds: number[],
      quiz: ReturnType<typeof addQuiz>
    ) {
      startLesson(userId, lessonIds[0], true);
      startLesson(userId, lessonIds[1]);
      watchLesson(userId, lessonIds[0]);
      attemptQuiz(userId, quiz);
      rate(userId, courseId, 4);
    }

    const ONE_OF_EACH = {
      enrolled: true,
      lessonProgress: 2,
      watchEvents: 1,
      quizAttempts: 1,
      quizAnswers: 1,
      ratings: 1,
    };

    it("makes it an Issued Refund, recording the admin and the moment", () => {
      const admin = addAdmin();
      const refundRequest = approveOpenRequest(admin.id);

      const result = markRefundIssued(refundRequest.id, admin.id);

      expect(result).toMatchObject({
        issued: true,
        refundRequest: {
          id: refundRequest.id,
          status: schema.RefundStatus.Approved,
          amountRefunded: 7900,
          issuedAt: NOW.toISOString(),
          issuedByUserId: admin.id,
          learner: { id: world.user.id },
          course: { id: world.course.id },
        },
      });
    });

    it("keeps the purchase and the Refund Request as the record", () => {
      const admin = addAdmin();
      const refundRequest = approveOpenRequest(admin.id);

      markRefundIssued(refundRequest.id, admin.id);

      expect(listRefundRequests()).toMatchObject([
        {
          id: refundRequest.id,
          amountPaid: 7900,
          reason: REASON,
          issuedAt: NOW.toISOString(),
        },
      ]);
    });

    it("ends the learner's enrollment and leaves the course not Locked", () => {
      const admin = addAdmin();
      const refundRequest = approveOpenRequest(admin.id);

      markRefundIssued(refundRequest.id, admin.id);

      expect(isCourseLocked(world.user.id, world.course.id)).toBe(false);
      expect(
        holdingsOf(world.user.id, world.course.id, world.lessonIds).enrolled
      ).toBe(false);
    });

    it("erases the learner's lesson progress, quiz attempts and answers, watch events and rating in the course", () => {
      const admin = addAdmin();
      const quiz = addQuiz(world.lessonIds[0]);
      const refundRequest = approveOpenRequest(admin.id);
      buildProgress(world.user.id, world.course.id, world.lessonIds, quiz);
      expect(
        holdingsOf(world.user.id, world.course.id, world.lessonIds)
      ).toEqual(ONE_OF_EACH);

      markRefundIssued(refundRequest.id, admin.id);

      expect(
        holdingsOf(world.user.id, world.course.id, world.lessonIds)
      ).toEqual(NOTHING);
      expect(listRefundRequests()).toMatchObject([
        { lessonsCompleted: 0, secondsWatched: 0 },
      ]);
    });

    it("stops the learner's rating counting toward the course's rating", () => {
      const admin = addAdmin();
      const other = addUser("Olga Other");
      const refundRequest = approveOpenRequest(admin.id);
      rate(world.user.id, world.course.id, 1);
      rate(other.id, world.course.id, 5);

      markRefundIssued(refundRequest.id, admin.id);

      expect(ratingsOf(world.course.id)).toEqual([5]);
    });

    it("shows the learner's comments as deleted with their content removed, and keeps other learners' replies", () => {
      const admin = addAdmin();
      const other = addUser("Olga Other");
      const refundRequest = approveOpenRequest(admin.id);
      const question = comment(
        world.user.id,
        world.lessonIds[0],
        "Why does this lesson skip generics?"
      );
      const reply = comment(
        other.id,
        world.lessonIds[0],
        "They come back in module 3.",
        question.id
      );
      const othersQuestion = comment(
        other.id,
        world.lessonIds[1],
        "Is there a transcript?"
      );
      const learnersReply = comment(
        world.user.id,
        world.lessonIds[1],
        "Yes, under the video.",
        othersQuestion.id
      );

      markRefundIssued(refundRequest.id, admin.id);

      expect(getComment(question.id)).toMatchObject({
        body: "",
        deletedAt: NOW.toISOString(),
      });
      expect(getComment(learnersReply.id)).toMatchObject({
        body: "",
        deletedAt: NOW.toISOString(),
      });
      expect(getComment(reply.id)).toMatchObject({
        body: "They come back in module 3.",
        parentId: question.id,
        deletedAt: null,
      });
      expect(getComment(othersQuestion.id)).toMatchObject({
        body: "Is there a transcript?",
        deletedAt: null,
      });
    });

    it("removes the content of a comment the learner had already deleted", () => {
      const admin = addAdmin();
      const refundRequest = approveOpenRequest(admin.id);
      const deleted = testDb
        .insert(schema.comments)
        .values({
          userId: world.user.id,
          lessonId: world.lessonIds[0],
          body: "Something I took back.",
          deletedAt: daysAgo(2),
        })
        .returning()
        .get();

      markRefundIssued(refundRequest.id, admin.id);

      expect(getComment(deleted.id)).toMatchObject({
        body: "",
        deletedAt: daysAgo(2),
      });
    });

    it("leaves the learner's enrollment and Progress in every other course unchanged", () => {
      const admin = addAdmin();
      const other = addOtherCourse();
      const otherQuiz = addQuiz(other.lessonIds[0]);
      enroll(world.user.id, other.course.id);
      buildProgress(world.user.id, other.course.id, other.lessonIds, otherQuiz);
      const otherComment = comment(
        world.user.id,
        other.lessonIds[0],
        "Loving this one."
      );
      const refundRequest = approveOpenRequest(admin.id);

      markRefundIssued(refundRequest.id, admin.id);

      expect(
        holdingsOf(world.user.id, other.course.id, other.lessonIds)
      ).toEqual(ONE_OF_EACH);
      expect(getComment(otherComment.id)).toMatchObject({
        body: "Loving this one.",
        deletedAt: null,
      });
    });

    it("leaves another learner's enrollment and Progress in the same course unchanged", () => {
      const admin = addAdmin();
      const other = addUser("Olga Other");
      const quiz = addQuiz(world.lessonIds[0]);
      enroll(other.id, world.course.id);
      buildProgress(other.id, world.course.id, world.lessonIds, quiz);
      const refundRequest = approveOpenRequest(admin.id);

      markRefundIssued(refundRequest.id, admin.id);

      expect(holdingsOf(other.id, world.course.id, world.lessonIds)).toEqual(
        ONE_OF_EACH
      );
    });

    it("leaves no room for another Refund Request on the refunded purchase", () => {
      const admin = addAdmin();
      const refundRequest = approveOpenRequest(admin.id);

      markRefundIssued(refundRequest.id, admin.id);

      expect(getRefundEligibility(world.user.id, world.course.id)).toEqual({
        eligible: false,
        reason: "already_refunded",
        message: "This purchase has already been refunded.",
      });
      expect(
        raiseRefundRequest(world.user.id, world.course.id, REASON, true)
      ).toMatchObject({ raised: false, reason: "already_refunded" });
    });

    // One failure for each step of the erase, wherever in the order it falls.
    it.each([
      ["ending the enrollment", "DELETE ON enrollments"],
      ["erasing lesson progress", "DELETE ON lesson_progress"],
      ["erasing quiz answers", "DELETE ON quiz_answers"],
      ["erasing quiz attempts", "DELETE ON quiz_attempts"],
      ["erasing watch events", "DELETE ON video_watch_events"],
      ["erasing the rating", "DELETE ON course_ratings"],
      ["deleting comments", "UPDATE ON comments"],
    ])(
      "leaves access and Progress as they were when %s fails",
      (_step, failingWrite) => {
        const admin = addAdmin();
        const quiz = addQuiz(world.lessonIds[0]);
        const refundRequest = approveOpenRequest(admin.id);
        buildProgress(world.user.id, world.course.id, world.lessonIds, quiz);
        const question = comment(
          world.user.id,
          world.lessonIds[0],
          "Why does this lesson skip generics?"
        );
        testDb.run(
          sql.raw(
            `CREATE TRIGGER fail_partway BEFORE ${failingWrite} BEGIN SELECT RAISE(ABORT, 'disk full'); END`
          )
        );

        expect(() => markRefundIssued(refundRequest.id, admin.id)).toThrow(
          "disk full"
        );

        expect(
          holdingsOf(world.user.id, world.course.id, world.lessonIds)
        ).toEqual(ONE_OF_EACH);
        expect(getComment(question.id)).toMatchObject({
          body: "Why does this lesson skip generics?",
          deletedAt: null,
        });
        // Still a Pending Refund, so the course is still Locked.
        expect(isCourseLocked(world.user.id, world.course.id)).toBe(true);
        expect(listRefundRequests()).toMatchObject([
          { issuedAt: null, issuedByUserId: null, lessonsCompleted: 1 },
        ]);
      }
    );

    it("is refused for a Refund that is already issued", () => {
      const admin = addAdmin();
      const laterAdmin = addUser("Lena Later", schema.UserRole.Admin);
      const refundRequest = approveOpenRequest(admin.id);
      markRefundIssued(refundRequest.id, admin.id);
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));

      const again = markRefundIssued(refundRequest.id, laterAdmin.id);

      expect(again).toEqual({
        issued: false,
        reason: "refund_already_issued",
        message: "That refund has already been marked as issued.",
      });
      // The record still shows who issued it first, and when.
      expect(listRefundRequests()).toMatchObject([
        { issuedAt: NOW.toISOString(), issuedByUserId: admin.id },
      ]);
    });

    it("is refused for an Open Refund Request, which keeps its Progress", () => {
      const admin = addAdmin();
      const refundRequest = raiseOpenRequest();
      completeLessons(world, 3);

      const result = markRefundIssued(refundRequest.id, admin.id);

      expect(result).toEqual({
        issued: false,
        reason: "request_not_approved",
        message:
          "Only an approved refund request can have its refund marked as issued.",
      });
      expect(listRefundRequests()).toMatchObject([
        {
          status: schema.RefundStatus.Open,
          issuedAt: null,
          lessonsCompleted: 3,
        },
      ]);
      expect(
        holdingsOf(world.user.id, world.course.id, world.lessonIds).enrolled
      ).toBe(true);
    });

    it("is refused for a Declined Refund Request", () => {
      const admin = addAdmin();
      const refundRequest = raiseOpenRequest();
      declineRefundRequest(refundRequest.id, admin.id);

      expect(markRefundIssued(refundRequest.id, admin.id)).toMatchObject({
        issued: false,
        reason: "request_not_approved",
      });
      expect(
        holdingsOf(world.user.id, world.course.id, world.lessonIds).enrolled
      ).toBe(true);
    });

    it("is refused to the course's instructor and to the learner, and nothing is erased", () => {
      const admin = addAdmin();
      const refundRequest = approveOpenRequest(admin.id);
      completeLessons(world, 3);

      for (const userId of [world.instructor.id, world.user.id]) {
        expect(markRefundIssued(refundRequest.id, userId)).toEqual({
          issued: false,
          reason: "not_admin",
          message: "Only admins can mark a refund as issued.",
        });
      }
      expect(listRefundRequests()).toMatchObject([
        { issuedAt: null, lessonsCompleted: 3 },
      ]);
      expect(isCourseLocked(world.user.id, world.course.id)).toBe(true);
    });

    it("is refused for a Refund Request that doesn't exist", () => {
      const admin = addAdmin();

      expect(markRefundIssued(999, admin.id)).toEqual({
        issued: false,
        reason: "request_not_found",
        message: "That refund request does not exist.",
      });
    });

    describe("buying the course again after an Issued Refund", () => {
      /** The learner's first purchase, refunded all the way to issued. */
      function refundFirstPurchase() {
        const admin = addAdmin();
        const refundRequest = approveOpenRequest(admin.id);
        const issued = markRefundIssued(refundRequest.id, admin.id);
        if (!issued.issued) throw new Error("Marking as issued was refused");
        return admin;
      }

      it("tells a first-time buyer their purchase is not a Final Purchase", () => {
        expect(isNextPurchaseFinal(world.user.id, world.course.id)).toBe(false);
      });

      it("tells a learner with an Issued Refund that buying again is a Final Purchase", () => {
        refundFirstPurchase();

        expect(isNextPurchaseFinal(world.user.id, world.course.id)).toBe(true);
      });

      it("keeps a Final Purchase to that learner and that course", () => {
        refundFirstPurchase();
        const other = addUser("Olive Other");
        const { course: otherCourse } = addOtherCourse();

        expect(isNextPurchaseFinal(other.id, world.course.id)).toBe(false);
        expect(isNextPurchaseFinal(world.user.id, otherCourse.id)).toBe(false);
      });

      it("refuses a Refund Request on a Final Purchase, saying it can't be refunded", () => {
        refundFirstPurchase();
        buyCourse(world, daysAgo(0));

        expect(getRefundEligibility(world.user.id, world.course.id)).toEqual({
          eligible: false,
          reason: "final_purchase",
          message:
            "You have already had a refund for this course, so this purchase is final and can't be refunded.",
        });
        expect(
          raiseRefundRequest(world.user.id, world.course.id, REASON, true)
        ).toMatchObject({ raised: false, reason: "final_purchase" });
        expect(isCourseLocked(world.user.id, world.course.id)).toBe(false);
        expect(listLearnerRefundRequests(world.user.id)).toHaveLength(1);
      });

      it("starts the learner from zero, enrolled and free to rate the course again", () => {
        const quiz = addQuiz(world.lessonIds[0]);
        const admin = addAdmin();
        const refundRequest = approveOpenRequest(admin.id);
        buildProgress(world.user.id, world.course.id, world.lessonIds, quiz);
        markRefundIssued(refundRequest.id, admin.id);

        buyCourse(world, daysAgo(0));

        expect(
          holdingsOf(world.user.id, world.course.id, world.lessonIds)
        ).toEqual({ ...NOTHING, enrolled: true });
        // Nothing of the old rating stands in the way of a new one.
        rate(world.user.id, world.course.id, 2);
        expect(ratingsOf(world.course.id)).toEqual([2]);
      });

      it("does not make a purchase Final when the earlier Refund Request was declined", () => {
        const admin = addAdmin();
        const refundRequest = raiseOpenRequest();
        declineRefundRequest(refundRequest.id, admin.id);

        expect(isNextPurchaseFinal(world.user.id, world.course.id)).toBe(false);
        expect(
          getRefundEligibility(world.user.id, world.course.id)
        ).toMatchObject({ eligible: true });
      });

      it("does not make a purchase Final when the earlier Refund Request was withdrawn", () => {
        const refundRequest = raiseOpenRequest();
        withdrawRefundRequest(world.user.id, refundRequest.id);

        expect(isNextPurchaseFinal(world.user.id, world.course.id)).toBe(false);
        expect(
          getRefundEligibility(world.user.id, world.course.id)
        ).toMatchObject({ eligible: true });
      });

      it("does not make a purchase Final while the earlier Refund is only pending", () => {
        approveOpenRequest(addAdmin().id);

        expect(isNextPurchaseFinal(world.user.id, world.course.id)).toBe(false);
      });

      it("keeps every later purchase of the course Final too", () => {
        refundFirstPurchase();
        buyCourse(world, daysAgo(0));

        expect(isNextPurchaseFinal(world.user.id, world.course.id)).toBe(true);
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

  describe("withdrawing a Refund Request", () => {
    it("unlocks the course when the learner withdraws their Open Refund Request", () => {
      buyCourse(world);
      const refundRequest = raise(world);

      const result = withdrawRefundRequest(world.user.id, refundRequest.id);

      expect(result).toMatchObject({
        withdrawn: true,
        refundRequest: { id: refundRequest.id, status: "withdrawn" },
      });
      expect(isCourseLocked(world.user.id, world.course.id)).toBe(false);
    });

    it("refuses anyone but the learner who raised it, and leaves the course Locked", () => {
      buyCourse(world);
      const refundRequest = raise(world);
      const classmate = testDb
        .insert(schema.users)
        .values({
          name: "Classmate",
          email: "classmate@example.com",
          role: schema.UserRole.Student,
        })
        .returning()
        .get();

      const result = withdrawRefundRequest(classmate.id, refundRequest.id);

      expect(result).toEqual({
        withdrawn: false,
        reason: "request_not_found",
        message: "We couldn't find that refund request.",
      });
      expect(isCourseLocked(world.user.id, world.course.id)).toBe(true);
    });

    it.each([
      ["approved", schema.RefundStatus.Approved],
      ["declined", schema.RefundStatus.Declined],
      ["already withdrawn", schema.RefundStatus.Withdrawn],
    ])("refuses to withdraw a Refund Request that is %s", (_label, status) => {
      const purchase = buyCourse(world);
      // Deciding a request belongs to the team; set the decided state up
      // directly.
      const refundRequest = testDb
        .insert(schema.refunds)
        .values({ purchaseId: purchase.id, reason: REASON, status })
        .returning()
        .get();

      const result = withdrawRefundRequest(world.user.id, refundRequest.id);

      expect(result).toEqual({
        withdrawn: false,
        reason: "request_not_open",
        message: "Only an open refund request can be withdrawn.",
      });
    });

    it("lets the learner raise a new Refund Request after withdrawing", () => {
      buyCourse(world);
      withdrawRefundRequest(world.user.id, raise(world).id);

      const again = raiseRefundRequest(
        world.user.id,
        world.course.id,
        REASON,
        true
      );

      expect(again).toMatchObject({ raised: true, amount: 7900 });
      expect(isCourseLocked(world.user.id, world.course.id)).toBe(true);
    });

    it("holds a new Refund Request after withdrawing to the usual limits", () => {
      buyCourse(world, daysAgo(14));
      withdrawRefundRequest(world.user.id, raise(world).id);

      // The next day the 14-day window has closed.
      vi.setSystemTime(new Date(2026, 5, 21, 12, 0, 0));

      expect(
        raiseRefundRequest(world.user.id, world.course.id, REASON, true)
      ).toMatchObject({ raised: false, reason: "window_closed" });
    });

    it("leaves the learner's Progress exactly as it was", () => {
      buyCourse(world);
      completeLessons(world, 3);
      watch(world, 0, 900);
      const progressBefore = {
        lessons: testDb.select().from(schema.lessonProgress).all(),
        watched: testDb.select().from(schema.videoWatchEvents).all(),
      };

      withdrawRefundRequest(world.user.id, raise(world).id);

      // The module has no interface onto Progress, so read the rows.
      expect({
        lessons: testDb.select().from(schema.lessonProgress).all(),
        watched: testDb.select().from(schema.videoWatchEvents).all(),
      }).toEqual(progressBefore);
      expect(progressBefore.lessons).toHaveLength(3);
    });

    it("lists the learner's Refund Requests with their state, newest first", () => {
      buyCourse(world);
      const first = raise(world);
      withdrawRefundRequest(world.user.id, first.id);
      const second = raise(world);

      expect(listLearnerRefundRequests(world.user.id)).toMatchObject([
        {
          id: second.id,
          status: "open",
          refundIssued: false,
          courseTitle: "Test Course",
          courseSlug: "test-course",
          amountPaid: 7900,
          reason: REASON,
        },
        { id: first.id, status: "withdrawn", refundIssued: false },
      ]);
      // Nobody else sees them.
      expect(listLearnerRefundRequests(world.instructor.id)).toEqual([]);
    });

    it("keeps the course Locked when the learner tries to withdraw after approval", () => {
      const purchase = buyCourse(world);
      const refundRequest = testDb
        .insert(schema.refunds)
        .values({
          purchaseId: purchase.id,
          reason: REASON,
          status: schema.RefundStatus.Approved,
        })
        .returning()
        .get();

      withdrawRefundRequest(world.user.id, refundRequest.id);

      expect(isCourseLocked(world.user.id, world.course.id)).toBe(true);
    });
  });
});
