import { createInterface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";

const label = (value) => stripVTControlCharacters(String(value ?? "")).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
const number = (story) => story.issue?.number ?? (/^issue:(\d+)$/.exec(story.story?.externalId ?? "")?.[1]);
const pageSize = 15;

export function filterStories(stories, query, needsYou) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return stories.filter((story) => {
    if (needsYou && !story.attention?.length) return false;
    const text = label([story.project.slug, story.project.name, `${story.project.slug}#${number(story) ?? ""}`, story.id, story.title, number(story), story.phase, story.session?.holder?.name ?? "free"].join(" ")).toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** Line-based search keeps selection usable in terminals without cursor controls. */
export async function pickStory(stories, { stdin = process.stdin, stdout = process.stdout } = {}) {
  const readline = createInterface({ input: stdin, output: stdout, terminal: false });
  let needsYou = true;
  let query = "";
  let page = 0;
  try {
    while (true) {
      const matches = filterStories(stories, query, needsYou);
      const start = page * pageSize;
      const visible = matches.slice(start, start + pageSize);
      stdout.write(`\n${needsYou ? "Stories that need you" : "All stories"}${query ? ` · ${label(query)}` : ""} (${matches.length})\n`);
      visible.forEach((story, index) => {
        const issue = number(story);
        const holder = story.session?.holder;
        stdout.write(`${index + 1}. ${label(story.project.slug)}${issue ? `#${label(issue)}` : ""} · ${label(story.title)} · ${label(story.id)} · ${label(story.phase)} · ${holder ? `${label(holder.name)}${holder.since ? ` since ${label(holder.since)}` : ""}` : "free"}\n`);
      });
      if (!matches.length) stdout.write("No matching stories. Change the search or use /all.\n");
      if (matches.length > pageSize) stdout.write(`Page ${page + 1}/${Math.ceil(matches.length / pageSize)} · /next · /prev\n`);
      stdout.write("Enter a number to attach, text to filter, / to clear, /all, /needs-you, or /cancel.\n");
      const answer = await new Promise((resolve) => {
        const closed = () => resolve(null);
        readline.once("close", closed);
        readline.question("Search or select: ").then((value) => {
          readline.removeListener("close", closed);
          resolve(value.trim());
        }, () => resolve(null));
      });
      if (answer === null || answer === "/cancel") return null;
      if (/^[0-9]+$/.test(answer)) {
        const selected = visible[Number(answer) - 1];
        if (selected) return selected;
        stdout.write("Choose a displayed number, or prefix a numeric search with / (for example /101).\n");
        continue;
      }
      if (answer === "/next") { if (start + pageSize < matches.length) page++; continue; }
      if (answer === "/prev") { page = Math.max(0, page - 1); continue; }
      if (answer === "/all") { needsYou = false; query = ""; }
      else if (answer === "/needs-you") { needsYou = true; query = ""; }
      else query = answer.replace(/^\//, "");
      page = 0;
    }
  } finally { readline.close(); }
}
