import { Lock } from "lucide-react";

/**
 * The short form of the Locked message, for course cards and lists. It stands
 * where the learner's progress would be: a Locked course can't be continued.
 * The course page tells the full story and holds the way to withdraw.
 */
export function CourseLockedNotice() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <Lock className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <div>
        <div className="font-medium">This course is locked for you</div>
        <p className="text-muted-foreground">
          You asked for a refund on this course, so you can't open its lessons.
        </p>
      </div>
    </div>
  );
}
