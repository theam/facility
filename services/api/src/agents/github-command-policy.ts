import type { GithubClientFactory } from "../github/client.js";

type GithubObject = Record<string, unknown>;

/** Commands inside quoted or fenced examples are data, not requests. */
export function requestedGithubCommands(body: string): Set<string> {
  const commands = new Set<string>();
  let fence: { character: string; length: number } | undefined;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker?.[1]?.startsWith(fence.character) &&
        marker[1].length >= fence.length &&
        marker[2]?.trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    if (marker?.[1]) {
      fence = { character: marker[1][0] ?? "", length: marker[1].length };
      continue;
    }
    const command = /^ {0,3}(\/[a-z][a-z0-9-]*)(?=$|[\s,.:;!?)])/.exec(line)?.[1];
    if (command) commands.add(command);
  }
  return commands;
}

export function githubIssueCommandMatches(
  command: string,
  configuredCommands: ReadonlySet<string>,
  eventType: string,
  payload: GithubObject,
): boolean {
  if (eventType !== "issue_comment" || payload.action !== "created") return false;
  const issue = object(payload.issue);
  if (issue.pull_request !== undefined || issue.state !== "open") return false;
  const comment = object(payload.comment);
  if (typeof comment.body !== "string") return false;
  const requested = [...requestedGithubCommands(comment.body)].filter((value) =>
    configuredCommands.has(value),
  );
  return requested.length === 1 && requested[0] === command;
}

export async function githubSenderCanStartAgent(input: {
  factory: GithubClientFactory;
  installationId: number;
  owner: string;
  repo: string;
  sender: unknown;
}): Promise<boolean> {
  const sender = object(input.sender);
  if (
    sender.type !== "User" ||
    typeof sender.login !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(sender.login)
  ) {
    return false;
  }
  try {
    const client = await input.factory(input.installationId);
    if (!client.request) return false;
    const result = await client.request(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      { owner: input.owner, repo: input.repo, username: sender.login },
    );
    const permission = object(result.data).permission;
    // GitHub reports maintain as "write" here; the distinct role is in role_name.
    return permission === "admin" || permission === "write";
  } catch (error) {
    const status = object(error).status;
    if (status === 401 || status === 403 || status === 404) return false;
    // Retry transient provider failures; never interpret them as permission.
    throw error;
  }
}

function object(value: unknown): GithubObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as GithubObject) : {};
}
