import { handleRoute, okResponse } from "@/server/response";
import { requireUserId } from "@/server/auth/session";
import { getUserById } from "@/server/db/queries";
import { db } from "@/server/db";
import { comments, users } from "@/server/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import * as errors from "@/server/errors";
import { revalidateCoursePublicData, revalidateRanklistPublicData } from "@/server/cache";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const userId = await requireUserId();
    const user = await getUserById(userId);
    if (!user.isCommunityAdmin && !user.isAdmin) throw errors.PermissionDenied();

    const { id, reward } = await req.json();
    const commentId = Number(id);

    const [comment] = await db
      .select()
      .from(comments)
      .where(and(eq(comments.id, commentId), isNull(comments.deletedAt)));
    if (!comment) throw errors.CommentNotExists();

    const oldReward = comment.reward ?? 0;
    const delta = reward - oldReward;

    await db.update(comments).set({ reward, updatedAt: new Date() }).where(eq(comments.id, commentId));

    // Adjust user's total reward
    if (delta !== 0) {
      await db
        .update(users)
        .set({ reward: sql`${users.reward} + ${delta}` })
        .where(eq(users.id, comment.userId!));
      revalidateRanklistPublicData();
    }

    await revalidateCoursePublicData(comment.courseId!);

    return okResponse(null);
  });
}
