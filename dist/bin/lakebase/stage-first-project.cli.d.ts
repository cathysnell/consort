#!/usr/bin/env node
/** The bundled seed dir (overridable for tests). */
declare function bundledSeedDir(): string;
interface StageResult {
    seedDir: string;
    consortDir: string;
    staged: string[];
    features: string[];
}
/**
 * Copy the bundled first-project seed into <projectDir>/.consort/. Returns what was
 * staged. Throws only if the seed itself is missing (a packaging fault) – the callers
 * (bin + start.md) surface that clearly rather than half-staging silently.
 */
declare function stageFirstProject(opts?: {
    projectDir?: string;
    seedDir?: string;
}): StageResult;

export { type StageResult, bundledSeedDir, stageFirstProject };
