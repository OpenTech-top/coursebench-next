import { handleRoute, okResponse } from "@/server/response";
import { requireUserId } from "@/server/auth/session";
import { getUserById } from "@/server/db/queries";
import { db } from "@/server/db";
import { comments, courseGroups, courses } from "@/server/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import * as errors from "@/server/errors";
import { revalidateCoursePublicData } from "@/server/cache";

const SCORE_LENGTH = 4;

export async function POST(req: Request) {
  return handleRoute(async () => {
    const userId = await requireUserId();
    const { id } = await req.json();

    const [comment] = await db
      .select()
      .from(comments)
      .where(and(eq(comments.id, Number(id)), isNull(comments.deletedAt)));
    if (!comment) throw errors.CommentNotExists();

    const user = await getUserById(userId);
    if (comment.userId !== userId && !user.isAdmin) {
      throw errors.PermissionDenied();
    }

    // Soft delete
    await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, comment.id));

    // Recalculate scores
    const cgComments = await db
      .select({ scores: comments.scores })
      .from(comments)
      .where(and(eq(comments.courseGroupId, comment.courseGroupId!), isNull(comments.deletedAt)));

    const cgScoreSum = new Array(SCORE_LENGTH).fill(0);
    for (const c of cgComments) {
      if (c.scores?.length === SCORE_LENGTH) {
        for (let i = 0; i < SCORE_LENGTH; i++) cgScoreSum[i] += Number(c.scores[i]);
      }
    }

    await db
      .update(courseGroups)
      .set({ scores: cgScoreSum, commentCount: cgComments.length, updatedAt: new Date() })
      .where(eq(courseGroups.id, comment.courseGroupId!));

    const allGroups = await db
      .select({ scores: courseGroups.scores, commentCount: courseGroups.commentCount })
      .from(courseGroups)
      .where(and(eq(courseGroups.courseId, comment.courseId!), isNull(courseGroups.deletedAt)));

    const courseScoreSum = new Array(SCORE_LENGTH).fill(0);
    let totalComments = 0;
    for (const g of allGroups) {
      if (g.scores?.length === SCORE_LENGTH) {
        for (let i = 0; i < SCORE_LENGTH; i++) courseScoreSum[i] += Number(g.scores[i]);
      }
      totalComments += g.commentCount ?? 0;
    }

    await db
      .update(courses)
      .set({ scores: courseScoreSum, commentCount: totalComments, updatedAt: new Date() })
      .where(eq(courses.id, comment.courseId!));

    await revalidateCoursePublicData(comment.courseId!);

    return okResponse(null);
  });
}
