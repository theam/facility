/** @param {string} mode */
export function isBuilderMode(mode) {
  const canonical = mode.replaceAll("_", "-");
  return canonical === "builder" || canonical.endsWith("-builder");
}

/** @param {unknown} value */
export function agentDefTriggersBuilder(value) {
  if (!Array.isArray(value)) return false;
  return value.some((trigger) => {
    const entry = objectValue(trigger);
    const command = stringValue(entry.command) ?? stringValue(entry.handle);
    return command ? isBuilderMode(command.replace(/^\//, "")) : false;
  });
}

/** @param {string} name @param {unknown} triggers */
export function isBuilderAgent(name, triggers) {
  return isBuilderMode(name) || agentDefTriggersBuilder(triggers);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function runObjectiveText(value) {
  const trigger = objectValue(value);
  for (const candidate of [trigger.message, trigger.approvedPlan, trigger.input]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }

  const input = trigger.input;
  if (
    (Array.isArray(input) && input.length > 0) ||
    (input !== null && typeof input === "object" && Object.keys(input).length > 0)
  ) {
    return JSON.stringify(input, null, 2);
  }

  const issue = objectValue(trigger.issue);
  const issueNumber = issue.number;
  if (typeof issueNumber === "number" && Number.isInteger(issueNumber) && issueNumber > 0) {
    return `Implement the governed GitHub issue #${issueNumber} described in Scope.`;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** @param {unknown} value @returns {string | null} */
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
