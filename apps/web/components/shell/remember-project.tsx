"use client";

import { useEffect } from "react";
import { rememberLastProject } from "@/lib/last-project";

/** Records the project in focus so `/` can land the user back in it. */
export function RememberProject({ projectId }: { projectId: string }) {
  useEffect(() => {
    void rememberLastProject(projectId);
  }, [projectId]);
  return null;
}
