import { z } from "zod";

export const JOBS = ["plan", "do", "check", "critique"] as const;
export type Job = (typeof JOBS)[number];

// How a role maps to models:
// - single: one model plays the role.
// - ladder: a do role starts on the first model and moves one rung up each
//   time a check (or a malformed output) sends the work back.
// - jury: a check or critique role asks every model and combines the answers.
export type ModelSpec =
  | { kind: "single"; model: string }
  | { kind: "ladder"; models: string[] }
  | { kind: "jury"; models: string[] };

export interface RoleSettings {
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface Role {
  name: string;
  job: Job;
  instructions: string;
  tools: string[];
  models: ModelSpec;
  settings: RoleSettings;
}

export interface Panel {
  name: string;
  roles: Role[];
}

const settingsSchema = z
  .object({
    maxTokens: z.number().int().positive().max(64_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();

const roleSchema = z
  .object({
    name: z.string().min(1),
    job: z.enum(JOBS),
    instructions: z.string().default(""),
    tools: z.array(z.string()).default([]),
    model: z.string().min(1).optional(),
    ladder: z.array(z.string().min(1)).min(2).optional(),
    jury: z.array(z.string().min(1)).min(2).optional(),
    settings: settingsSchema.default({}),
  })
  .strict();

const panelSchema = z
  .object({
    name: z.string().min(1),
    roles: z.array(roleSchema).min(1),
  })
  .strict();

export class PanelError extends Error {}

export function parsePanel(input: unknown): Panel {
  const parsed = panelSchema.safeParse(input);
  if (!parsed.success) throw new PanelError(`invalid panel: ${z.prettifyError(parsed.error)}`);
  const seen = new Set<string>();
  const roles: Role[] = parsed.data.roles.map((r) => {
    if (seen.has(r.name)) throw new PanelError(`duplicate role name "${r.name}"`);
    seen.add(r.name);
    const given = [r.model, r.ladder, r.jury].filter((x) => x !== undefined).length;
    if (given !== 1) {
      throw new PanelError(`role "${r.name}" needs exactly one of "model", "ladder" or "jury"`);
    }
    let models: ModelSpec;
    if (r.model) models = { kind: "single", model: r.model };
    else if (r.ladder) models = { kind: "ladder", models: r.ladder };
    else models = { kind: "jury", models: r.jury! };

    if (models.kind === "ladder" && r.job !== "do") {
      throw new PanelError(`role "${r.name}": a ladder only makes sense for a do role`);
    }
    if (models.kind === "jury" && r.job !== "check" && r.job !== "critique") {
      throw new PanelError(`role "${r.name}": a jury is only for check or critique roles`);
    }
    return { name: r.name, job: r.job, instructions: r.instructions, tools: r.tools, models, settings: r.settings };
  });
  if (!roles.some((r) => r.job === "do")) throw new PanelError(`panel "${parsed.data.name}" has no do role`);
  return { name: parsed.data.name, roles };
}

export function findRole(panel: Panel, name: string): Role | undefined {
  return panel.roles.find((r) => r.name === name);
}

export function defaultDoRole(panel: Panel): Role {
  const role = panel.roles.find((r) => r.job === "do");
  if (!role) throw new PanelError("panel has no do role");
  return role;
}

export function modelsOf(spec: ModelSpec): string[] {
  return spec.kind === "single" ? [spec.model] : spec.models;
}

// The model a do role uses after `rung` send-backs.
export function ladderModel(spec: ModelSpec, rung: number): string {
  if (spec.kind === "single") return spec.model;
  return spec.models[Math.min(rung, spec.models.length - 1)]!;
}
