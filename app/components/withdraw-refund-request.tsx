import { useEffect } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";

/**
 * The learner's way to take back an Open Refund Request, which unlocks the
 * course at once. Show it only while the request is Open: there is no
 * withdrawing after approval.
 */
export function WithdrawRefundRequest({
  courseSlug,
  refundRequestId,
}: {
  courseSlug: string;
  refundRequestId: number;
}) {
  const fetcher = useFetcher<{
    withdrawn?: boolean;
    errors?: Record<string, string>;
  }>();
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    const firstError = Object.values(fetcher.data.errors ?? {})[0];
    if (firstError) {
      toast.error(firstError);
    } else if (fetcher.data.withdrawn) {
      toast.success("Refund request withdrawn. Your course is unlocked.");
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <fetcher.Form method="post" action={`/courses/${courseSlug}/refund`}>
      <input type="hidden" name="intent" value="withdraw" />
      <input type="hidden" name="refundRequestId" value={refundRequestId} />
      <Button type="submit" variant="outline" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Withdrawing..." : "Withdraw refund request"}
      </Button>
    </fetcher.Form>
  );
}
