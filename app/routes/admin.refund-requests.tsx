import { useEffect } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refund-requests";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { formatDuration, formatPrice } from "~/lib/utils";
import { sendEmail, type Email } from "~/lib/email.server";
import {
  approveRefundRequest,
  canDecideRefundRequests,
  declineRefundRequest,
  listRefundRequests,
  markRefundIssued,
  type MarkRefundIssuedRefusalReason,
  type RefundDecisionRefusalReason,
  type RefundRequestDetails,
} from "~/lib/refund-requests.server";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { AlertTriangle, ReceiptText } from "lucide-react";

const refundDecisionActionSchema = z.object({
  intent: z.enum(["approve", "decline", "mark-issued"]),
  refundRequestId: z.coerce.number().int(),
});

// How each reason the team's action on a Refund Request is refused is
// reported over HTTP. The reasons themselves, and their wording, belong to the
// Refund Request module.
const REFUSAL_STATUS: Record<
  RefundDecisionRefusalReason | MarkRefundIssuedRefusalReason,
  number
> = {
  not_admin: 403,
  request_not_found: 404,
  request_not_open: 409,
  request_not_approved: 409,
  refund_already_issued: 409,
};

/** The message the learner gets when their Refund Request is decided. */
function buildRefundDecisionEmail(refundRequest: RefundRequestDetails): Email {
  const { learner, course } = refundRequest;
  const approved = refundRequest.state === "pending_refund";

  return {
    to: learner.email,
    subject: approved
      ? `Refund request approved — ${course.title}`
      : `Refund request declined — ${course.title}`,
    body: [
      `Hi ${learner.name},`,
      "",
      ...(approved
        ? [
            `We have approved your refund request for "${course.title}".`,
            `Your refund of ${formatPrice(refundRequest.amountRefunded)}, the amount you paid, is on its way.`,
            "",
            "The course stays locked and your progress is kept until the refund is issued. When it is, the course leaves your account and your progress in it is erased for good. We will email you again when that happens.",
          ]
        : [
            `We have declined your refund request for "${course.title}", so there is no refund.`,
            "",
            "The course is unlocked again and your progress is as you left it. If you still want a refund, you can raise a new refund request from the course page while the purchase is still refundable.",
          ]),
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

/** The message the learner gets when their Refund is issued. */
function buildRefundIssuedEmail(refundRequest: RefundRequestDetails): Email {
  const { learner, course } = refundRequest;

  return {
    to: learner.email,
    subject: `Refund issued — ${course.title}`,
    body: [
      `Hi ${learner.name},`,
      "",
      `Your refund of ${formatPrice(refundRequest.amountRefunded)} for "${course.title}" has been issued.`,
      "",
      "The course is no longer in your account, and your progress in it has been erased for good. Your other courses are unchanged.",
      "",
      "You can buy the course again, starting from the beginning. That purchase could not be refunded.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Decide refund requests and mark refunds as issued" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to see refund requests.", {
      status: 401,
    });
  }

  if (!canDecideRefundRequests(currentUserId)) {
    throw data("Only admins can access this page.", { status: 403 });
  }

  const refundRequests = listRefundRequests();

  return {
    openRefundRequests: refundRequests
      .filter((refundRequest) => refundRequest.state === "open")
      // The team works through them oldest first.
      .reverse(),
    pendingRefunds: refundRequests
      .filter((refundRequest) => refundRequest.state === "pending_refund")
      .reverse(),
    pastRefundRequests: refundRequests.filter(
      (refundRequest) =>
        refundRequest.state !== "open" &&
        refundRequest.state !== "pending_refund"
    ),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in.", { status: 401 });
  }

  if (!canDecideRefundRequests(currentUserId)) {
    throw data("Only admins can decide refund requests.", { status: 403 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundDecisionActionSchema);

  if (!parsed.success) {
    throw data(Object.values(parsed.errors)[0] ?? "Invalid input.", {
      status: 400,
    });
  }

  const { intent, refundRequestId } = parsed.data;

  if (intent === "mark-issued") {
    const issued = markRefundIssued(refundRequestId, currentUserId);

    if (!issued.issued) {
      throw data(issued.message, { status: REFUSAL_STATUS[issued.reason] });
    }

    sendEmail(buildRefundIssuedEmail(issued.refundRequest));

    return { message: "Refund marked as issued." };
  }

  const result =
    intent === "approve"
      ? approveRefundRequest(refundRequestId, currentUserId)
      : declineRefundRequest(refundRequestId, currentUserId);

  if (!result.decided) {
    throw data(result.message, { status: REFUSAL_STATUS[result.reason] });
  }

  sendEmail(buildRefundDecisionEmail(result.refundRequest));

  return {
    message:
      intent === "approve"
        ? "Refund request approved."
        : "Refund request declined.",
  };
}

type RefundRequestRow = Route.ComponentProps["loaderData"]["openRefundRequests"][number];

const HEADER_CELL =
  "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";

function LearnerCell({ refundRequest }: { refundRequest: RefundRequestRow }) {
  return (
    <td className="px-4 py-3 align-top">
      <div className="text-sm font-medium">{refundRequest.learner.name}</div>
      <div className="text-xs text-muted-foreground">
        {refundRequest.learner.email}
      </div>
    </td>
  );
}

function CourseCell({ refundRequest }: { refundRequest: RefundRequestRow }) {
  return (
    <td className="px-4 py-3 align-top text-sm">
      <Link
        to={`/courses/${refundRequest.course.slug}`}
        className="hover:underline"
      >
        {refundRequest.course.title}
      </Link>
    </td>
  );
}

function OpenRefundRequestRow({
  refundRequest,
}: {
  refundRequest: RefundRequestRow;
}) {
  const fetcher = useFetcher<typeof action>();
  const isDeciding = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      toast.success(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data]);

  function decide(intent: "approve" | "decline") {
    fetcher.submit(
      { intent, refundRequestId: String(refundRequest.id) },
      { method: "post" }
    );
  }

  return (
    <tr className="border-b border-border last:border-0">
      <LearnerCell refundRequest={refundRequest} />
      <CourseCell refundRequest={refundRequest} />
      <td className="px-4 py-3 align-top text-sm">
        {formatPrice(refundRequest.amountPaid)}
      </td>
      <td className="max-w-xs px-4 py-3 align-top text-sm">
        {refundRequest.reason}
      </td>
      <td className="px-4 py-3 align-top text-sm text-muted-foreground">
        {new Date(refundRequest.requestedAt).toLocaleDateString()}
      </td>
      <td className="px-4 py-3 align-top text-sm text-muted-foreground">
        <div>
          {refundRequest.lessonsCompleted} of {refundRequest.lessonCount}{" "}
          lessons completed
        </div>
        <div>
          {formatDuration(
            Math.round(refundRequest.secondsWatched / 60),
            true,
            false,
            false
          )}{" "}
          watched
        </div>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => decide("approve")}
            disabled={isDeciding}
          >
            Approve
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => decide("decline")}
            disabled={isDeciding}
          >
            Decline
          </Button>
        </div>
      </td>
    </tr>
  );
}

function PendingRefundRow({
  refundRequest,
}: {
  refundRequest: RefundRequestRow;
}) {
  const fetcher = useFetcher<typeof action>();
  const isMarking = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      toast.success(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data]);

  function markIssued() {
    const confirmed = confirm(
      `Mark the refund of ${formatPrice(refundRequest.amountRefunded)} to ${refundRequest.learner.name} as issued?\n\n` +
        `This can't be undone. ${refundRequest.learner.name} loses "${refundRequest.course.title}" and their progress in it is erased for good.`
    );
    if (!confirmed) return;

    fetcher.submit(
      { intent: "mark-issued", refundRequestId: String(refundRequest.id) },
      { method: "post" }
    );
  }

  return (
    <tr className="border-b border-border last:border-0">
      <LearnerCell refundRequest={refundRequest} />
      <CourseCell refundRequest={refundRequest} />
      <td className="px-4 py-3 align-top text-sm">
        {formatPrice(refundRequest.amountRefunded)}
      </td>
      <td className="px-4 py-3 align-top text-sm text-muted-foreground">
        {refundRequest.resolvedBy && refundRequest.resolvedAt
          ? `${refundRequest.resolvedBy.name}, ${new Date(refundRequest.resolvedAt).toLocaleDateString()}`
          : "—"}
      </td>
      <td className="px-4 py-3 align-top">
        <Button
          variant="destructive"
          size="sm"
          className="h-7 text-xs"
          onClick={markIssued}
          disabled={isMarking}
        >
          Mark as issued
        </Button>
      </td>
    </tr>
  );
}

function outcomeOf(refundRequest: RefundRequestRow): string {
  switch (refundRequest.state) {
    case "issued_refund":
      return `Approved — refund of ${formatPrice(refundRequest.amountRefunded)} issued`;
    case "pending_refund":
      return `Approved — refund of ${formatPrice(refundRequest.amountRefunded)} pending`;
    case "declined":
      return "Declined — no refund";
    case "withdrawn":
      return "Withdrawn by the learner";
    case "open":
      return "Open";
  }
}

function PastRefundRequestRow({
  refundRequest,
}: {
  refundRequest: RefundRequestRow;
}) {
  return (
    <tr className="border-b border-border last:border-0">
      <LearnerCell refundRequest={refundRequest} />
      <CourseCell refundRequest={refundRequest} />
      <td className="px-4 py-3 align-top text-sm">
        {formatPrice(refundRequest.amountPaid)}
      </td>
      <td className="max-w-xs px-4 py-3 align-top text-sm">
        {refundRequest.reason}
      </td>
      <td className="px-4 py-3 align-top text-sm text-muted-foreground">
        {new Date(refundRequest.requestedAt).toLocaleDateString()}
      </td>
      <td className="px-4 py-3 align-top text-sm">{outcomeOf(refundRequest)}</td>
      <td className="px-4 py-3 align-top text-sm text-muted-foreground">
        {refundRequest.resolvedBy && refundRequest.resolvedAt
          ? `${refundRequest.resolvedBy.name}, ${new Date(refundRequest.resolvedAt).toLocaleDateString()}`
          : "—"}
      </td>
    </tr>
  );
}

export default function AdminRefundRequests({
  loaderData,
}: Route.ComponentProps) {
  const { openRefundRequests, pendingRefunds, pastRefundRequests } =
    loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approve or decline the refund requests learners have raised, and
          mark refunds as issued once the money is sent
        </p>
      </div>

      <h2 className="mb-3 text-lg font-semibold">
        Open ({openRefundRequests.length})
      </h2>
      {openRefundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              No open refund requests. Nothing is waiting on a decision.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className={HEADER_CELL}>Learner</th>
                    <th className={HEADER_CELL}>Course</th>
                    <th className={HEADER_CELL}>Amount paid</th>
                    <th className={HEADER_CELL}>Reason</th>
                    <th className={HEADER_CELL}>Raised</th>
                    <th className={HEADER_CELL}>Progress</th>
                    <th className={HEADER_CELL}>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {openRefundRequests.map((refundRequest) => (
                    <OpenRefundRequestRow
                      key={refundRequest.id}
                      refundRequest={refundRequest}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <h2 className="mb-3 mt-10 text-lg font-semibold">
        Pending refunds ({pendingRefunds.length})
      </h2>
      {pendingRefunds.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No pending refunds. Every approved refund has been issued.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            Approved, with the money not yet confirmed as sent. Marking a refund
            as issued ends the learner's access to the course and erases their
            progress in it. It can't be undone.
          </p>
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className={HEADER_CELL}>Learner</th>
                      <th className={HEADER_CELL}>Course</th>
                      <th className={HEADER_CELL}>Refund</th>
                      <th className={HEADER_CELL}>Approved by</th>
                      <th className={HEADER_CELL}>Money sent?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingRefunds.map((refundRequest) => (
                      <PendingRefundRow
                        key={refundRequest.id}
                        refundRequest={refundRequest}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <h2 className="mb-3 mt-10 text-lg font-semibold">
        Past refund requests ({pastRefundRequests.length})
      </h2>
      {pastRefundRequests.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No refund request has been decided or withdrawn yet.
        </p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className={HEADER_CELL}>Learner</th>
                    <th className={HEADER_CELL}>Course</th>
                    <th className={HEADER_CELL}>Amount paid</th>
                    <th className={HEADER_CELL}>Reason</th>
                    <th className={HEADER_CELL}>Raised</th>
                    <th className={HEADER_CELL}>Outcome</th>
                    <th className={HEADER_CELL}>Decided by</th>
                  </tr>
                </thead>
                <tbody>
                  {pastRefundRequests.map((refundRequest) => (
                    <PastRefundRequestRow
                      key={refundRequest.id}
                      refundRequest={refundRequest}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refund requests.";
  // A refused approve, decline or mark-as-issued lands here too. The admin
  // may still use the page, so offer the way back to it.
  let canReturnToList = false;

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins can access this page.";
    } else {
      title =
        error.status === 409
          ? "That can't be done any more"
          : `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
      canReturnToList = true;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          {canReturnToList && (
            <Link to="/admin/refund-requests" reloadDocument>
              <Button variant="outline">Back to refund requests</Button>
            </Link>
          )}
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
