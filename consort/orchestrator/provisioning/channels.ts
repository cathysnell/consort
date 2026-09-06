// channels: the output-channel model – the ONE definition of the three channels a step's output can
// land in and the rule that resolves each to a directory root. A run's environment provisions up to
// three roots (the product code tree + optional contained artifact/meta zones); this is the shared
// rule every consumer (the StepExecutor's validate phase + Step.run) uses to place an output.
// Extracted here so the product/artifact/meta ternary lives in one place instead of being retyped at
// each call site (the DRY consolidation – byte-identical to the prior inline copies).
//
//   product  : the real code tree – ALWAYS workspaceDir (uncontained).
//   artifact : the .consort design documents – artifactDir when provisioned, else workspaceDir.
//   meta     : orchestration bookkeeping (raw report / verdict / marker) – metaDir when provisioned,
//              else workspaceDir.
//
// With neither artifactDir nor metaDir provisioned, every channel resolves to workspaceDir – exactly
// the pre-channel behavior.

/** The output channel a step's declared output lands in. */
export type Channel = "product" | "artifact" | "meta";

/** The directory roots a run's environment provisions. workspaceDir is always present (the product
 *  code tree); artifactDir / metaDir are the optional contained zones. */
export interface ChannelRoots {
  workspaceDir: string;
  artifactDir?: string;
  metaDir?: string;
}

/** Resolve the root directory a channel's output lands under (artifact/meta fall back to workspaceDir
 *  when their contained root was not provisioned; product is always workspaceDir). */
export function resolveChannelRoot(channel: Channel | undefined, roots: ChannelRoots): string {
  return channel === "artifact"
    ? roots.artifactDir ?? roots.workspaceDir
    : channel === "meta"
      ? roots.metaDir ?? roots.workspaceDir
      : roots.workspaceDir;
}
