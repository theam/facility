export type GithubGitIdentity = { name: string; email: string };

type IdentitySource = {
  app: () => Promise<{ slug?: string }>;
  user: (login: string, token: string) => Promise<{ id?: number; login?: string; type?: string }>;
};

/** Resolve the authenticated App's bot, rather than inventing a commit email. */
export function createGithubGitIdentityLoader(source: IdentitySource) {
  let pending: Promise<GithubGitIdentity> | undefined;
  return (token: string): Promise<GithubGitIdentity> => {
    pending ??= load(token).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };

  async function load(token: string): Promise<GithubGitIdentity> {
    const app = await source.app();
    if (typeof app.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(app.slug)) {
      throw new Error("GitHub App omitted a valid bot slug");
    }
    const login = `${app.slug}[bot]`;
    const user = await source.user(login, token);
    if (
      user.type !== "Bot" ||
      typeof user.login !== "string" ||
      user.login.toLowerCase() !== login.toLowerCase() ||
      !Number.isSafeInteger(user.id) ||
      (user.id ?? 0) <= 0
    ) {
      throw new Error("GitHub App bot identity could not be verified");
    }
    return { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
  }
}
