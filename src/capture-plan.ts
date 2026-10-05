/** A rectangle in CSS pixels. */
export type Rect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** How a Capture was started, and from which element. */
export type CaptureStart = {
  /** A Pick Capture: the element the user clicked in Pick mode. */
  readonly _tag: "pick"
  readonly element: Element
}

/**
 * The page layout the plan reads. The browser measures it; a test provides it, because
 * happy-dom does no layout.
 */
export type Layout = {
  /** The element's border box relative to the viewport, as `getBoundingClientRect()` reports it. */
  readonly boundsOf: (element: Element) => Rect

  /** How far the document is scrolled, in CSS pixels. */
  readonly scroll: { readonly x: number; readonly y: number }
}

/** What a Capture shows and where it is on the page. */
export type CapturePlan = {
  /** What the Capture shows. */
  readonly target: Element

  /**
   * The Target's full border box in document coordinates, however much of it is on screen.
   * Fractions are kept: the debugger's screenshot clip takes fractional CSS pixels and
   * rounds only when it produces the image.
   */
  readonly crop: Rect
}

/**
 * Decide what a Capture shows and which part of the page to crop.
 *
 * @param input - How the Capture was started and the page layout to measure it in.
 * @returns The plan for the Capture.
 */
export function planCapture(input: {
  readonly start: CaptureStart
  readonly layout: Layout
}): CapturePlan {
  const { start, layout } = input
  const target = start.element
  const bounds = layout.boundsOf(target)

  return {
    target,
    crop: {
      x: bounds.x + layout.scroll.x,
      y: bounds.y + layout.scroll.y,
      width: bounds.width,
      height: bounds.height,
    },
  }
}
