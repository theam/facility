export function isSafeGitBranch(branch: string) {
  const hasControlOrForbiddenCharacter = [...branch].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
  });
  return Boolean(
    branch &&
      branch.length <= 200 &&
      !branch.startsWith("-") &&
      !branch.startsWith("/") &&
      !branch.endsWith("/") &&
      !branch.endsWith(".") &&
      !branch.includes("..") &&
      !branch.includes("@{") &&
      !hasControlOrForbiddenCharacter,
  );
}
