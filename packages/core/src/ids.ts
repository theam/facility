import { uuidv7 } from "uuidv7";

export const ID_PREFIXES = {
  org: "org",
  user: "user",
  member: "member",
  role: "role",
  proj: "proj",
  repo: "repo",
  run: "run",
  sess: "sess",
  agent: "agent",
  sbx: "sbx",
  pvh: "pvh",
  key: "key",
  prov: "prov",
  vkey: "vkey",
  bud: "bud",
  prop: "prop",
  act: "act",
  kb: "kb",
  task: "task",
  item: "item",
  ver: "ver",
  bun: "bun",
  iss: "iss",
  ghi: "ghi",
  ghp: "ghp",
  cie: "cie",
  evt: "evt",
  int: "int",
  fp: "fp",
} as const;

export type IdPrefix = keyof typeof ID_PREFIXES;

export function newId(prefix: IdPrefix): string {
  return `${ID_PREFIXES[prefix]}_${uuidv7().replaceAll("-", "")}`;
}
