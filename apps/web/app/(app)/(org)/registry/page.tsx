import { redirect } from "next/navigation";

/** The registry is the Harness now (REDESIGN §3 — decision #4). */
export default function LegacyRegistryRedirect() {
  redirect("/harness");
}
