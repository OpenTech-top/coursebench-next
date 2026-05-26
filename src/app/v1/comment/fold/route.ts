import { handleRoute, okResponse } from "@/server/response";
import { requireUserId } from "@/server/auth/session";
import { getUserById } from "@/server/db/queries";
import { db } from "@/server/db";
import { comments } from "@/server/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import * as errors from "@/server/errors";
import { revalidateCoursePublicData } from "@/server/cache";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const userId = await requireUserId();
    const user = await getUserById(userId);
    if (!user.isAdmin) throw errors.PermissionDenied();

    const { id, status } = await req.json();

    const [comment] = await db
      .select()
      .from(comments)
      .where(and(eq(comments.id, Number(id)), isNull(comments.deletedAt)));
    if (!comment) throw errors.CommentNotExists();

    await db.update(comments).set({ isFold: !!status, updatedAt: new Date() }).where(eq(comments.id, comment.id));

    await revalidateCoursePublicData(comment.courseId!);

    return okResponse({});
  });
}
