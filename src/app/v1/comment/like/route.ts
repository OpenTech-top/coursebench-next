import { handleRoute, okResponse } from "@/server/response";
import { requireUserId } from "@/server/auth/session";
import { db } from "@/server/db";
import { comments, commentLikes } from "@/server/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import * as errors from "@/server/errors";
import { revalidateCoursePublicData } from "@/server/cache";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const userId = await requireUserId();
    const { id, status } = await req.json(); // status: 0=none, 1=like, 2=dislike

    const commentId = Number(id);
    const [comment] = await db
      .select()
      .from(comments)
      .where(and(eq(comments.id, commentId), isNull(comments.deletedAt)));
    if (!comment) throw errors.CommentNotExists();
    if (comment.userId === userId) throw errors.InvalidArgument(); // can't like own comment

    // Find existing like
    const [existing] = await db
      .select()
      .from(commentLikes)
      .where(
        and(
          eq(commentLikes.userId, userId),
          eq(commentLikes.commentId, commentId),
          isNull(commentLikes.deletedAt),
        ),
      );

    let likeDelta = 0;
    let dislikeDelta = 0;

    if (existing) {
      const wasLike = existing.isLike;
      if (status === 0) {
        // Remove like/dislike
        await db.update(commentLikes).set({ deletedAt: new Date() }).where(eq(commentLikes.id, existing.id));
        if (wasLike) likeDelta = -1;
        else dislikeDelta = -1;
      } else {
        const newIsLike = status === 1;
        if (newIsLike !== wasLike) {
          await db.update(commentLikes).set({ isLike: newIsLike, updatedAt: new Date() }).where(eq(commentLikes.id, existing.id));
          if (newIsLike) { likeDelta = 1; dislikeDelta = -1; }
          else { likeDelta = -1; dislikeDelta = 1; }
        }
      }
    } else if (status !== 0) {
      await db.insert(commentLikes).values({
        userId,
        commentId,
        isLike: status === 1,
      });
      if (status === 1) likeDelta = 1;
      else dislikeDelta = 1;
    }

    if (likeDelta !== 0 || dislikeDelta !== 0) {
      await db
        .update(comments)
        .set({
          like: (comment.like ?? 0) + likeDelta,
          dislike: (comment.dislike ?? 0) + dislikeDelta,
        })
        .where(eq(comments.id, commentId));
      await revalidateCoursePublicData(comment.courseId!);
    }

    return okResponse({});
  });
}
