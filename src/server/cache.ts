import { revalidateTag, unstable_cache } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { courseTeachers } from "./db/schema";

export const PUBLIC_CACHE_SECONDS = 24 * 60 * 60;
export const PUBLIC_API_CACHE_CONTROL = `public, s-maxage=60, stale-while-revalidate=${PUBLIC_CACHE_SECONDS - 60}`;

export const cacheTags = {
  courses: "courses",
  course: (courseId: number) => `course:${courseId}`,
  teachers: "teachers",
  teacher: (teacherId: number) => `teacher:${teacherId}`,
  ranklist: "ranklist",
  recentComments: "comments:recent",
  courseComments: (courseId: number) => `comments:course:${courseId}`,
};

export function cachePublic<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  keyParts: string[],
  tags: string[],
): T {
  return unstable_cache(fn, keyParts, {
    revalidate: PUBLIC_CACHE_SECONDS,
    tags,
  }) as unknown as T;
}

export function revalidatePublicTag(tag: string) {
  try {
    revalidateTag(tag, "max");
  } catch (err) {
    console.error(`Failed to revalidate cache tag "${tag}"`, err);
  }
}

export async function revalidateCoursePublicData(courseId: number) {
  revalidatePublicTag(cacheTags.courses);
  revalidatePublicTag(cacheTags.course(courseId));
  revalidatePublicTag(cacheTags.courseComments(courseId));
  revalidatePublicTag(cacheTags.recentComments);

  try {
    const teacherRows = await db
      .select({ teacherId: courseTeachers.teacherId })
      .from(courseTeachers)
      .where(eq(courseTeachers.courseId, courseId));

    if (teacherRows.length > 0) {
      revalidatePublicTag(cacheTags.teachers);
      for (const row of teacherRows) {
        revalidatePublicTag(cacheTags.teacher(row.teacherId));
      }
    }
  } catch (err) {
    console.error(`Failed to revalidate teacher cache for course ${courseId}`, err);
  }
}

export function revalidateRanklistPublicData() {
  revalidatePublicTag(cacheTags.ranklist);
}
