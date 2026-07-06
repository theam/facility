"use server";

import { cookies } from "next/headers";
import { LAST_PROJECT_COOKIE } from "./last-project-cookie";

/**
 * The org landing (`/`) drops the user into the last project they worked in
 * (Vercel-style). The project shell records it via this action on mount.
 */
export async function rememberLastProject(projectId: string) {
  const jar = await cookies();
  jar.set(LAST_PROJECT_COOKIE, projectId, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
