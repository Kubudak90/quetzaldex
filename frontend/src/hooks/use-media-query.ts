// Quetzal — viewport hooks.
//
// The app styles almost everything with inline `CSSProperties`, which outrank
// any non-`!important` CSS rule. Media queries alone therefore cannot restyle
// the layout, so breakpoints are resolved in JS and fed back into those same
// inline styles. Structural changes (side nav -> bottom tab bar) need JS anyway.

import { useEffect, useState } from "react";

/** Below this the shell switches to the stacked, single-column phone layout. */
export const MOBILE_BREAKPOINT = 860;
/** Below this even two-up card rows collapse (small phones). */
export const NARROW_BREAKPOINT = 560;

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Sync once on mount: `query` may have changed since the initial state.
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);
}

export function useIsNarrow(): boolean {
  return useMediaQuery(`(max-width: ${NARROW_BREAKPOINT}px)`);
}
