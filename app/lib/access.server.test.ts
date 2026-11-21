import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

// The resolver talks to `~/db`. Point that at a fresh in-memory database,
// built from the real migrations, for every test.
let testDb: ReturnType<typeof createTestDb>;
vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Who is signed in, and where the DevUI says they are.
const mockSession = new Map<string, string | number>();
vi.mock("~/lib/session", () => ({
  getSession: vi.fn(async () => ({
    get: (key: string) => mockSession.get(key),
  })),
  getCurrentUserId: vi.fn(async () => {
    const userId = mockSession.get("userId");
    return typeof userId === "number" ? userId : null;
  }),
}));

import { getAccess, requireContentAccess } from "./access.server";
import {
  approveRefundRequest,
  declineRefundRequest,
  getLockingRefundRequest,
  raiseRefundRequest,
  withdrawRefundRequest,
} from "./refund-requests.server";

const NOW = new Date(2026, 5, 20, 12, 0, 0);

function daysAgo(days: number): string {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

const REASON = "Bought the wrong one, I meant the advanced course.";

type World = ReturnType<typeof seedBaseData>;

function signInAs(userId: number) {
  mockSession.set("userId", userId);
}

function makeRequest(): Request {
  return new Request("http://localhost:3000");
}

function buyCourse(
  userId: number,
  courseId: number,
  values: Partial<typeof schema.purchases.$inferInsert> = {}
) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId,
      courseId,
      amountPaid: 7900,
      createdAt: daysAgo(3),
      ...values,
    })
    .returning()
    .get();
  const enrolled = testDb
    .select()
    .from(schema.enrollments)
    .all()
    .some((row) => row.userId === userId && row.courseId === courseId);
  if (!enrolled) {
    testDb.insert(schema.enrollments).values({ userId, courseId }).run();
  }
  return purchase;
}

function addCourse(world: World, slug: string) {
  return testDb
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: "Another course",
      salesCopy: "Sales copy",
      instructorId: world.instructor.id,
      categoryId: world.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

describe("getAccess", () => {
  let world: World;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mockSession.clear();
    testDb = createTestDb();
    world = seedBaseData(testDb);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a learner who bought the course view it, unlocked", async () => {
    buyCourse(world.user.id, world.course.id);
    signInAs(world.user.id);

    const access = await getAccess(makeRequest(), world.course.id);

    expect(access).toMatchObject({
      enrolled: true,
      locked: false,
      canViewContent: true,
    });
  });

  it("reports a signed-out visitor as neither Locked nor able to view", async () => {
    const access = await getAccess(makeRequest(), world.course.id);

    expect(access).toMatchObject({ locked: false, canViewContent: false });
  });

  describe("once the learner raises a Refund Request", () => {
    beforeEach(() => {
      buyCourse(world.user.id, world.course.id);
      raiseRefundRequest(world.user.id, world.course.id, REASON, true);
    });

    it("reports the course as Locked and not viewable for that learner", async () => {
      signInAs(world.user.id);

      const access = await getAccess(makeRequest(), world.course.id);

      // Still theirs — Locked, not gone.
      expect(access).toMatchObject({
        enrolled: true,
        locked: true,
        canViewContent: false,
      });
    });

    it("refuses the learner's Progress writes in that course", async () => {
      signInAs(world.user.id);

      const refused = await requireContentAccess(
        makeRequest(),
        world.course.id
      ).catch((thrown) => thrown);

      expect(refused).toMatchObject({
        init: { status: 403 },
        data: expect.stringContaining("locked"),
      });
    });

    it("leaves the learner's other courses as they were", async () => {
      const otherCourse = addCourse(world, "other-course");
      buyCourse(world.user.id, otherCourse.id);
      signInAs(world.user.id);

      const access = await getAccess(makeRequest(), otherCourse.id);

      expect(access).toMatchObject({ locked: false, canViewContent: true });
    });

    it("leaves another learner of the same course unaffected", async () => {
      const classmate = testDb
        .insert(schema.users)
        .values({
          name: "Classmate",
          email: "classmate@example.com",
          role: schema.UserRole.Student,
        })
        .returning()
        .get();
      buyCourse(classmate.id, world.course.id);
      signInAs(classmate.id);

      const access = await getAccess(makeRequest(), world.course.id);

      expect(access).toMatchObject({ locked: false, canViewContent: true });
    });

    it("makes the course viewable again, still enrolled, once the learner withdraws", async () => {
      const refundRequest = getLockingRefundRequest(
        world.user.id,
        world.course.id
      )!;
      withdrawRefundRequest(world.user.id, refundRequest.id);
      signInAs(world.user.id);

      const access = await getAccess(makeRequest(), world.course.id);

      expect(access).toMatchObject({
        enrolled: true,
        locked: false,
        canViewContent: true,
      });
      // Progress writes are accepted again.
      await expect(
        requireContentAccess(makeRequest(), world.course.id)
      ).resolves.toMatchObject({ canViewContent: true });
    });

    it("stays Locked when someone else tries to withdraw the learner's Refund Request", async () => {
      const refundRequest = getLockingRefundRequest(
        world.user.id,
        world.course.id
      )!;
      withdrawRefundRequest(world.instructor.id, refundRequest.id);
      signInAs(world.user.id);

      const access = await getAccess(makeRequest(), world.course.id);

      expect(access).toMatchObject({ locked: true, canViewContent: false });
    });

    it("leaves the course's instructor unaffected", async () => {
      signInAs(world.instructor.id);

      const access = await getAccess(makeRequest(), world.course.id);

      expect(access).toMatchObject({
        isStaff: true,
        locked: false,
        canViewContent: true,
      });
    });
  });

  describe("once an admin decides the learner's Refund Request", () => {
    let adminId: number;
    let refundRequestId: number;

    beforeEach(() => {
      adminId = testDb
        .insert(schema.users)
        .values({
          name: "Admin",
          email: "admin@example.com",
          role: schema.UserRole.Admin,
        })
        .returning()
        .get().id;
      buyCourse(world.user.id, world.course.id);
      const raised = raiseRefundRequest(
        world.user.id,
        world.course.id,
        REASON,
        true
      );
      if (!raised.raised) throw new Error("The Refund Request was refused");
      refundRequestId = raised.refundRequest.id;
    });

    it("makes the course viewable again when it is declined", async () => {
      declineRefundRequest(refundRequestId, adminId);
      signInAs(world.user.id);

      const access = await getAccess(makeRequest(), world.course.id);

      expect(access).toMatchObject({
        enrolled: true,
        locked: false,
        canViewContent: true,
      });
    });

    it("lets the learner add Progress again when it is declined", async () => {
      declineRefundRequest(refundRequestId, adminId);
      signInAs(world.user.id);

      const access = await requireContentAccess(makeRequest(), world.course.id);

      expect(access.canViewContent).toBe(true);
    });

    it("keeps the course Locked and not viewable when it is approved", async () => {
      approveRefundRequest(refundRequestId, adminId);
      signInAs(world.user.id);

      const access = await getAccess(makeRequest(), world.course.id);

      // Still theirs until the Refund is issued.
      expect(access).toMatchObject({
        enrolled: true,
        locked: true,
        canViewContent: false,
      });
    });

    it("keeps the course Locked when an instructor tries to decline it", async () => {
      declineRefundRequest(refundRequestId, world.instructor.id);
      signInAs(world.user.id);

      const access = await getAccess(makeRequest(), world.course.id);

      expect(access).toMatchObject({ locked: true, canViewContent: false });
    });
  });

  it("keeps the course Locked while the Refund Request is approved and the Refund not yet issued", async () => {
    const purchase = buyCourse(world.user.id, world.course.id);
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
    signInAs(world.user.id);

    const access = await getAccess(makeRequest(), world.course.id);

    expect(access).toMatchObject({ locked: true, canViewContent: false });
  });

  it("does not lock an admin out of a course they asked to be refunded for", async () => {
    const admin = testDb
      .insert(schema.users)
      .values({
        name: "Admin",
        email: "admin@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    buyCourse(admin.id, world.course.id);
    raiseRefundRequest(admin.id, world.course.id, REASON, true);
    signInAs(admin.id);

    const access = await getAccess(makeRequest(), world.course.id);

    expect(access).toMatchObject({
      isStaff: true,
      locked: false,
      canViewContent: true,
    });
  });

  it("checks the country of the learner's latest purchase, not an earlier one", async () => {
    testDb
      .update(schema.courses)
      .set({ price: 7900, pppEnabled: true })
      .run();
    // Bought at a discount in India, then again at full price in the US.
    buyCourse(world.user.id, world.course.id, {
      country: "IN",
      createdAt: daysAgo(40),
    });
    buyCourse(world.user.id, world.course.id, {
      country: "US",
      createdAt: daysAgo(2),
    });
    signInAs(world.user.id);
    mockSession.set("devCountry", "US");

    const access = await getAccess(makeRequest(), world.course.id);

    expect(access).toMatchObject({ pppBlocked: false, canViewContent: true });
  });
});
