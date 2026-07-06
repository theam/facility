import { redirect } from "next/navigation";

/** Legacy path — the fleet lives at /sessions now. */
export default function LegacyRunsRedirect() {
  redirect("/sessions");
}
