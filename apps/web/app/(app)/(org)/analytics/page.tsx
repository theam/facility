import { redirect } from "next/navigation";

/** Analytics folded into the portfolio and project overviews (REDESIGN §4i). */
export default function LegacyAnalyticsRedirect() {
  redirect("/projects");
}
