import { redirect } from "next/navigation";

/** Sessions live inside each project now; the portfolio shows org-wide state. */
export default function LegacyRunsRedirect() {
  redirect("/projects");
}
