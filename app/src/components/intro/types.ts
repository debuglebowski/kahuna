/**
 * Contract for full-screen intro animations, playable from the Intro Lab page.
 *
 * Every intro component:
 * - renders a `fixed inset-0 z-[100]` overlay and opens on a dark frame
 * - plays its choreography once, then calls `onDone` exactly once
 * - skips on click or Escape (fast ~200ms fade-out, then `onDone`)
 * - honors `prefers-reduced-motion` with a short static-fade variant
 * - cleans up rAF loops, listeners and timers on unmount
 */
export interface IntroProps {
  /** Fires once when the intro completes or is skipped. */
  onDone: () => void
}
