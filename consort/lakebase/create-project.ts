// Kit createProject: the Consort-flavored project scaffolder.
//
// The base 11-step orchestrator lives in @databricks-solutions/lakebase-scm-utils
// and is Consort-agnostic. This kit wrapper injects the Consort lay-down + config
// seeding (the `.consort/` bootstrap + consort-config.json) by default, so the kit's
// lakebase-create-project CLI keeps producing Consort-ready projects. Callers that
// want a plain SCM project pass `consortHooks: undefined` explicitly, or consume
// the base createProject from the substrate package directly.

import {
  createProject as baseCreateProject,
  type CreateProjectArgs,
  type CreateProjectResult,
  type ProgressCallback,
} from "@databricks-solutions/lakebase-scm-utils/lakebase";
import { kitConsortHooks, layDownTddScaffold } from "../../consort/setup/project-consort-setup.js";

export type { CreateProjectArgs, CreateProjectResult, ProgressCallback };
export { layDownTddScaffold };

/** A UI project (a React SPA client) ALWAYS wires the Playwright E2E harness, so the LOCAL
 *  deploy-verify gate runs E2E BEFORE CI – never letting CI be the first place E2E runs (the
 *  gap: `enable-e2e` was off by default, so a default-scaffolded UI project shipped its
 *  Playwright suite un-run until CI). For a UI project this is NOT optional – it overrides
 *  even an explicit `--no-e2e`. A backend-only project has no client E2E and honors the flag
 *  (undefined => the base scaffolder's default of off). */
export function resolveEnableE2e(
  input: Pick<CreateProjectArgs, "clientFramework" | "enableE2e">,
): boolean | undefined {
  return input.clientFramework === "react" ? true : input.enableE2e;
}

export function createProject(
  input: CreateProjectArgs,
  progress?: ProgressCallback,
): Promise<CreateProjectResult> {
  return baseCreateProject(
    { ...input, enableE2e: resolveEnableE2e(input), consortHooks: input.consortHooks ?? kitConsortHooks },
    progress,
  );
}
