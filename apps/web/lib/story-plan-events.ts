export const PLAN_PROPOSAL_EVENT = "facility:story-plan-proposal";
export type PlanProposalSource = {
  projectId: string;
  storyId: string;
  messageId: string;
  markdown: string;
};

export function requestPlanProposal(source: PlanProposalSource) {
  window.dispatchEvent(new CustomEvent(PLAN_PROPOSAL_EVENT, { detail: source }));
  document.getElementById("story-plan")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
