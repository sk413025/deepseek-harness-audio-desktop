/** Glyphs not shipped by ui-primitives, drawn on the same 16 px grid with currentColor. */

/**
 * Microphone outline glyph.
 * @param props.size - rendered edge length in pixels.
 * @returns decorative SVG (aria-hidden).
 */
export function MicIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="5.25" y="1.5" width="5.5" height="8.5" rx="2.75" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Filled square stop glyph.
 * @param props.size - rendered edge length in pixels.
 * @returns decorative SVG (aria-hidden).
 */
export function StopSquareIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  )
}
