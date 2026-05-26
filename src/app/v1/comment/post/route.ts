import { handleRoute, okResponse } from "@/server/response";
import { requireUserId } from "@/server/auth/session";
import { db } from "@/server/db";
import { comments, courseGroups, courses, users } from "@/server/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import * as errors from "@/server/errors";
import { revalidateCoursePublicData, revalidateRanklistPublicData } from "@/server/cache";

const SCORE_LENGTH = 4;

export async function POST(req: Request) {
  return handleRoute(async () => {
    const userId = await requireUserId();
    const body = await req.json();
    const { group, title, content, semester, is_anonymous, scores, student_score_ranking } = body;

    // Validate
    if (!title || title.length > 200) throw errors.InvalidArgument();
    if (!content || content.length > 50000) throw errors.InvalidArgument();
    if (!Array.isArray(scores) || scores.length !== SCORE_LENGTH) throw errors.InvalidArgument();
    for (const s of scores) {
      if (s < 1 || s > 5) throw errors.InvalidArgument();
    }
    if (student_score_ranking < 1 || student_score_ranking > 11) throw errors.InvalidArgument();

    // Validate semester: YYYYSS format (e.g. 202601 = 2026 semester 1)
    const semYear = Math.floor(semester / 100);
    const semNum = semester % 100;
    if (semYear < 2014 || semNum < 1 || semNum > 3) throw errors.InvalidArgument();

    // Get course group
    const [cg] = await db
      .select()
      .from(courseGroups)
      .where(and(eq(courseGroups.id, Number(group)), isNull(courseGroups.deletedAt)));
    if (!cg) throw errors.CourseGroupNotExists();

    // Check duplicate
    const [existing] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(
          eq(comments.userId, userId),
          eq(comments.courseGroupId, cg.id),
          isNull(comments.deletedAt),
        ),
      );
    if (existing) throw errors.CommentAlreadyExists();

    const now = Math.floor(Date.now() / 1000);

    const [newComment] = await db
      .insert(comments)
      .values({
        userId,
        courseGroupId: cg.id,
        courseId: cg.courseId,
        title,
        content,
        semester,
        isAnonymous: !!is_anonymous,
        scores,
        studentScoreRanking: student_score_ranking,
        createTime: now,
        updateTime: now,
      })
      .returning({ id: comments.id });

    // Update course group scores and comment count
    const cgComments = await db
      .select({ scores: comments.scores })
      .from(comments)
      .where(and(eq(comments.courseGroupId, cg.id), isNull(comments.deletedAt)));

    const cgScoreSum = new Array(SCORE_LENGTH).fill(0);
    for (const c of cgComments) {
      if (c.scores && c.scores.length === SCORE_LENGTH) {
        for (let i = 0; i < SCORE_LENGTH; i++) cgScoreSum[i] += Number(c.scores[i]);
      }
    }

    await db
      .update(courseGroups)
      .set({
        scores: cgScoreSum,
        commentCount: cgComments.length,
        updatedAt: new Date(),
      })
      .where(eq(courseGroups.id, cg.id));

    // Update course scores and comment count
    const allGroups = await db
      .select({ scores: courseGroups.scores, commentCount: courseGroups.commentCount })
      .from(courseGroups)
      .where(and(eq(courseGroups.courseId, cg.courseId!), isNull(courseGroups.deletedAt)));

    const courseScoreSum = new Array(SCORE_LENGTH).fill(0);
    let totalComments = 0;
    for (const g of allGroups) {
      if (g.scores && g.scores.length === SCORE_LENGTH) {
        for (let i = 0; i < SCORE_LENGTH; i++) courseScoreSum[i] += Number(g.scores[i]);
      }
      totalComments += g.commentCount ?? 0;
    }

    await db
      .update(courses)
      .set({
        scores: courseScoreSum,
        commentCount: totalComments,
        updatedAt: new Date(),
      })
      .where(eq(courses.id, cg.courseId!));

    // Reward inviter if first comment
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (user && !user.hasPostedComments && user.invitedByUserId) {
      await db
        .update(users)
        .set({ reward: sql`${users.reward} + 100` })
        .where(eq(users.id, user.invitedByUserId));
      await db.update(users).set({ hasPostedComments: true }).where(eq(users.id, userId));
    } else if (user && !user.hasPostedComments) {
      await db.update(users).set({ hasPostedComments: true }).where(eq(users.id, userId));
    }

    await revalidateCoursePublicData(cg.courseId!);
    if (user && !user.hasPostedComments && user.invitedByUserId) {
      revalidateRanklistPublicData();
    }

    return okResponse({ comment_id: newComment.id });
  });
}
