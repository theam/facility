/**
 * Server-owned permission contract for approval-gated MCP writes.
 *
 * The proposal route and delayed executor both consume this map so a stored
 * proposal cannot weaken or drift from the permission checked at creation.
 */
export const MCP_TOOL_PERMISSIONS: Readonly<Record<string, string>> = {
  facility_trigger_run: "runs:trigger",
  facility_cancel_run: "runs:write",
  facility_steer_run: "runs:steer",
  facility_interrupt_run: "runs:steer",
  facility_resume_run: "runs:trigger",
  facility_start_conversation: "runs:trigger",
  facility_send_conversation_message: "runs:trigger",
  facility_sync_github_issues: "repos:write",
  facility_trigger_github_issue: "runs:trigger",
  facility_create_project: "projects:write",
  facility_archive_project: "projects:write",
  facility_kickstart: "projects:kickstart",
  facility_upgrade_project: "projects:write",
  facility_set_budget: "budgets:write",
  facility_publish_registry_version: "registry:publish",
  facility_deprecate_registry_version: "registry:publish",
  facility_create_agent: "agents:write",
  facility_update_agent: "agents:write",
  facility_retire_agent: "agents:write",
  facility_ack_issue: "issues:write",
  facility_resolve_issue: "issues:write",
  facility_retry_webhook_delivery: "integrations:write",
  facility_create_task: "tasks:write",
  facility_transition_task: "tasks:write",
  facility_propose_task: "tasks:write",
  facility_amend_kb: "kb:write",
  facility_create_registry_draft: "registry:write",
  facility_connect_repo: "repos:write",
};
