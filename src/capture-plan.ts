import { err, ok } from "./prelude"
import type { Result } from "./prelude"

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

/** Why no Capture is taken. */
export type CaptureRefusal =
  /** The Target is too tall to fit in one image at full sharpness. */
  { readonly _tag: "oversized" }

/** Every Capture has two image pixels per CSS pixel, whatever the screen's pixel ratio. */
export const CAPTURE_SCALE = 2

/**
 * The tallest image Chromium produces, its maximum texture size. Above it the screenshot
 * repeats content instead of failing, so a taller Target is refused rather than captured.
 */
const MAX_IMAGE_HEIGHT = 16_384

/**
 * Decide what a Capture shows and which part of the page to crop, or why there is no Capture.
 *
 * @param input - How the Capture was started and the page layout to measure it in.
 * @returns The plan for the Capture, or the reason it is refused.
 */
export function planCapture(input: {
  readonly start: CaptureStart
  readonly layout: Layout
}): Result<CapturePlan, CaptureRefusal> {
  const { start, layout } = input
  const target = start.element
  const bounds = layout.boundsOf(target)

  if (bounds.height * CAPTURE_SCALE > MAX_IMAGE_HEIGHT) return err({ _tag: "oversized" })

  return ok({
    target,
    crop: {
      x: bounds.x + layout.scroll.x,
      y: bounds.y + layout.scroll.y,
      width: bounds.width,
      height: bounds.height,
    },
  })
}
