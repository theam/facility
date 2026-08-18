import { z } from "zod";

export type ChainTypeConfig = {
  prefix: string;
  name: string;
  parentTypes: string[];
  schema: z.ZodType<Record<string, unknown>>;
};

export type ArtifactChainConfig = {
  id: "research" | "product";
  name: string;
  activeName: "ACTIVE";
  charterName: "CHARTER";
  types: Record<string, ChainTypeConfig>;
};

const SharedFrontmatter = z
  .object({
    id: z.string().min(1),
    aliases: z.array(z.string()).min(1),
    type: z.string().min(1),
    created: z.string().min(1),
    tags: z.array(z.string()).default([]),
  })
  .passthrough();

const WsjfSchema = z.object({
  value: z.number().int().min(0),
  time: z.number().int().min(0),
  risk: z.number().int().min(0),
  effort: z.number().positive(),
});

export const productChain: ArtifactChainConfig = {
  id: "product",
  name: "Product Owner",
  activeName: "ACTIVE",
  charterName: "CHARTER",
  types: {
    S: {
      prefix: "S",
      name: "Signal",
      parentTypes: [],
      schema: SharedFrontmatter.extend({
        type: z.literal("S"),
        source: z.string().min(1),
        evidence_refs: z.array(z.string()).default([]),
      }).passthrough(),
    },
    D: {
      prefix: "D",
      name: "Decision",
      parentTypes: ["S"],
      schema: SharedFrontmatter.extend({
        type: z.literal("D"),
        status: z.enum(["proposed", "decided", "superseded"]),
        decided_by: z.string().optional(),
      }).passthrough(),
    },
    T: {
      prefix: "T",
      name: "Task",
      parentTypes: ["D"],
      schema: SharedFrontmatter.extend({
        type: z.literal("T"),
        status: z.enum(["draft", "proposed", "created", "in_progress", "done", "rejected"]),
        wsjf: WsjfSchema,
      }).passthrough(),
    },
    V: {
      prefix: "V",
      name: "Verification",
      parentTypes: ["T"],
      schema: SharedFrontmatter.extend({
        type: z.literal("V"),
        task: z.string().min(1),
        outcome: z.enum(["verified", "unverified", "regressed"]),
        refs: z.array(z.string()).default([]),
      }).passthrough(),
    },
    R: {
      // Stable documentation — architecture, conventions, runbooks. Free
      // (no parent required): reference material is curated, not derived, and
      // unlike Signals it is expected to stay current rather than accumulate.
      prefix: "R",
      name: "Reference",
      parentTypes: [],
      schema: SharedFrontmatter.extend({
        type: z.literal("R"),
        area: z.string().optional(),
      }).passthrough(),
    },
    L: {
      prefix: "L",
      name: "Learning",
      parentTypes: [],
      schema: SharedFrontmatter.extend({
        type: z.literal("L"),
      }).passthrough(),
    },
  },
};

export const researchChain: ArtifactChainConfig = {
  id: "research",
  name: "Research",
  activeName: "ACTIVE",
  charterName: "CHARTER",
  types: {
    H: {
      prefix: "H",
      name: "Hypothesis",
      parentTypes: [],
      schema: SharedFrontmatter.extend({ type: z.literal("H") }).passthrough(),
    },
    E: {
      prefix: "E",
      name: "Experiment",
      parentTypes: ["H"],
      schema: SharedFrontmatter.extend({ type: z.literal("E") }).passthrough(),
    },
    F: {
      prefix: "F",
      name: "Finding",
      parentTypes: ["E"],
      schema: SharedFrontmatter.extend({ type: z.literal("F") }).passthrough(),
    },
    L: {
      prefix: "L",
      name: "Literature",
      parentTypes: [],
      schema: SharedFrontmatter.extend({ type: z.literal("L") }).passthrough(),
    },
    CR: {
      prefix: "CR",
      name: "Challenge Review",
      parentTypes: [],
      schema: SharedFrontmatter.extend({ type: z.literal("CR") }).passthrough(),
    },
    SR: {
      prefix: "SR",
      name: "Strategic Review",
      parentTypes: ["CR"],
      schema: SharedFrontmatter.extend({ type: z.literal("SR") }).passthrough(),
    },
  },
};

export const bundledChains = {
  product: productChain,
  research: researchChain,
} as const;

export function chainFromConfig(config: unknown): ArtifactChainConfig {
  const value = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const explicit = value.chain ?? value.harnessChain;
  if (explicit === "product" || explicit === "product-chain") return productChain;
  if (explicit === "research" || explicit === "research-chain") return researchChain;
  const artifactTypes = Array.isArray(value.artifact_types) ? value.artifact_types : [];
  const prefixes = new Set(
    artifactTypes
      .map((item) =>
        item && typeof item === "object" ? (item as Record<string, unknown>).prefix : undefined,
      )
      .filter((item): item is string => typeof item === "string"),
  );
  if (["S", "D", "T", "V"].some((prefix) => prefixes.has(prefix))) return productChain;
  return researchChain;
}
