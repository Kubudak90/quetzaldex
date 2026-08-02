// Quetzal — shared external links + displayed versions.
//
// These were duplicated as file-local constants (and, in the side nav, as
// hardcoded strings that had drifted to a version the project never shipped).
// One definition so they can't disagree again.

export const GITHUB_URL = "https://github.com/Kubudak90/quetzaldex";
export const LITEPAPER_URL = "https://github.com/Kubudak90/quetzaldex/blob/main/LITEPAPER.md";
export const DOCS_URL = (import.meta.env.VITE_DOCS_URL as string | undefined) ?? "https://docs.quetzaldex.xyz";
export const FAUCET_URL = (import.meta.env.VITE_FAUCET_URL as string | undefined) ?? "https://faucet.quetzaldex.xyz";

/** Aztec protocol/toolchain this build targets. Keep in step with `.aztec-version`. */
export const AZTEC_VERSION = "5.0.0";

export { VERSION as SDK_VERSION } from "@quetzal/sdk";
