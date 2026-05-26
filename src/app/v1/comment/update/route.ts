import { handleRoute, okResponse } from "@/server/response";
import { requireUserId } from "@/server/auth/session";
import { db } from "@/server/db";
import { comments, courseGroups, courses } from "@/server/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import * as errors from "@/server/errors";
import { revalidateCoursePublicData } from "@/server/cache";

const SCORE_LENGTH = 4;

export async function POST(req: Request) {
  return handleRoute(async () => {
    const userId = await requireUserId();
    const body = await req.json();
    const { id, title, content, semester, is_anonymous, scores, student_score_ranking } = body;

    if (!title || title.length > 200) throw errors.InvalidArgument();
    if (!content || content.length > 50000) throw errors.InvalidArgument();
    if (!Array.isArray(scores) || scores.length !== SCORE_LENGTH) throw errors.InvalidArgument();
    for (const s of scores) {
      if (s < 1 || s > 5) throw errors.InvalidArgument();
    }

    const [comment] = await db
      .select()
      .from(comments)
      .where(and(eq(comments.id, Number(id)), isNull(comments.deletedAt)));
    if (!comment) throw errors.CommentNotExists();
    if (comment.userId !== userId) throw errors.PermissionDenied();

    const now = Math.floor(Date.now() / 1000);
    await db
      .update(comments)
      .set({
        title,
        content,
        semester,
        isAnonymous: !!is_anonymous,
        scores,
        studentScoreRanking: student_score_ranking,
        updateTime: now,
        updatedAt: new Date(),
      })
      .where(eq(comments.id, comment.id));

    // Recalculate course group and course scores
    await recalculateScores(comment.courseGroupId!, comment.courseId!);

    await revalidateCoursePublicData(comment.courseId!);

    return okResponse(null);
  });
}

async function recalculateScores(courseGroupId: number, courseId: number) {
  const cgComments = await db
    .select({ scores: comments.scores })
    .from(comments)
    .where(and(eq(comments.courseGroupId, courseGroupId), isNull(comments.deletedAt)));

  const cgScoreSum = new Array(SCORE_LENGTH).fill(0);
  for (const c of cgComments) {
    if (c.scores?.length === SCORE_LENGTH) {
      for (let i = 0; i < SCORE_LENGTH; i++) cgScoreSum[i] += Number(c.scores[i]);
    }
  }

  await db
    .update(courseGroups)
    .set({ scores: cgScoreSum, commentCount: cgComments.length, updatedAt: new Date() })
    .where(eq(courseGroups.id, courseGroupId));

  const allGroups = await db
    .select({ scores: courseGroups.scores, commentCount: courseGroups.commentCount })
    .from(courseGroups)
    .where(and(eq(courseGroups.courseId, courseId), isNull(courseGroups.deletedAt)));

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
    .where(eq(courses.id, courseId));
}
