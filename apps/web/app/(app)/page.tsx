import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import { LAST_PROJECT_COOKIE } from "@/lib/last-project-cookie";

/**
 * Land in the last project you worked in (Vercel-style); first project as a
 * fallback; the portfolio only when the org has no projects yet.
 */
export default async function Landing() {
  const jar = await cookies();
  const last = jar.get(LAST_PROJECT_COOKIE)?.value;
  const projects = await api.projects();
  if (!projects.ok) redirect("/projects");
  const list = projects.data.filter((p) => p.status !== "archived");
  if (last && list.some((p) => p.id === last)) redirect(`/projects/${last}`);
  if (list.length > 0) redirect(`/projects/${list[0]?.id}`);
  redirect("/projects");
}
