import { err, ok } from "./prelude"
import type { Result } from "./prelude"
import {
  clutterIn,
  containsPost,
  continuesFromAbove,
  conversationOf,
  cutOffQuotedPostsIn,
  focalPost,
  isPlaceholder,
  postContaining,
  postRefOf,
  showMoreIn,
} from "./x-markup"
import type { PostRef } from "./x-markup"

/** A rectangle in CSS pixels. */
export type Rect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** How a Capture was started, and from what. */
export type CaptureStart =
  | {
      /** A Pick Capture: the element the user clicked in Pick mode. */
      readonly _tag: "pick"
      readonly element: Element
    }
  | PostCaptureStart

/**
 * A Post Capture: the Post the user right-clicked. It is plain data, because the Capture is
 * planned on that Post's own status page, not on the page that was right-clicked.
 */
export type PostCaptureStart = { readonly _tag: "post"; readonly post: PostRef }

/** Where the user asked for the Capture to go. */
export type Destination = "clipboard" | "download"

/** Where a finished Capture is delivered, with what a Download needs. */
export type DestinationPlan =
  | { readonly _tag: "clipboard" }
  /** A PNG file in the downloads folder, saved under `filename`. */
  | { readonly _tag: "download"; readonly filename: string }

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
  /**
   * What the Capture shows, top to bottom: the picked element, or the Conversation from its
   * root Post down to the Focal post.
   */
  readonly target: Target

  /**
   * Page interface inside the Target that isn't content. It is taken out of the layout before
   * the Target is measured, so it leaves no gap. Only Target elements that are or contain a
   * Post have any.
   */
  readonly clutter: ReadonlyArray<Element>

  /**
   * The Target's full border box in document coordinates, however much of it is on screen. A
   * Conversation's box spans from its first Post's top to the Focal post's bottom.
   * Fractions are kept: the debugger's screenshot clip takes fractional CSS pixels and
   * rounds only when it produces the image.
   */
  readonly crop: Rect

  /** Where the Capture is delivered. */
  readonly destination: DestinationPlan

  /**
   * The Truncated text to expand before a Post Capture: X's "Show more" controls, which the
   * page clicks. A Pick Capture shows Truncated text as rendered, so it expands nothing.
   */
  readonly expand: ReadonlyArray<Element>

  /** Why the Capture is a Partial Capture; empty when it is complete. */
  readonly warnings: ReadonlyArray<CaptureWarning>
}

/** The elements a Capture shows, top to bottom; there is always at least one. */
export type Target = readonly [Element, ...Element[]]

/** Why a Capture is a Partial Capture: it is still delivered, with this warning. */
export type CaptureWarning =
  /** The Conversation has Posts X shows only as a placeholder, such as unavailable or deleted Posts. */
  | { readonly _tag: "unavailable-posts"; readonly count: number }
  /** Truncated text that expanding didn't show in full, or not in time. */
  | { readonly _tag: "not-expanded" }
  /** A quoted post whose text X shows only the start of, with no way to expand it. */
  | { readonly _tag: "quoted-post-cut-off" }
  /**
   * The Conversation starts below its root Post: X didn't render the Posts above its topmost
   * one, although that Post replies to one.
   */
  | { readonly _tag: "root-post-missing" }

/** Why no Capture is taken. */
export type CaptureRefusal =
  /** The Target is too tall to fit in one image at full sharpness. */
  | { readonly _tag: "oversized" }
  /** A Post Capture was started somewhere that isn't a Post. */
  | { readonly _tag: "no-post" }
  /** The clicked Post's status page doesn't show it as its Focal post, so it can't be captured. */
  | { readonly _tag: "post-not-shown" }

/** Every Capture has two image pixels per CSS pixel, whatever the screen's pixel ratio. */
export const CAPTURE_SCALE = 2

/**
 * The tallest image Chromium produces, its maximum texture size. Above it the screenshot
 * repeats content instead of failing, so a taller Target is refused rather than captured.
 */
const MAX_IMAGE_HEIGHT = 16_384

/**
 * Start a Post Capture from the element under a right-click. Inside a quoted post, the Post
 * that quotes it is captured.
 *
 * @param clicked - The element the user right-clicked.
 * @returns The start of a Post Capture of the clicked Post, or "no-post" when the element
 *   isn't part of a Post.
 */
export function startPostCapture(clicked: Element): Result<PostCaptureStart, CaptureRefusal> {
  const post = postContaining(clicked)
  const ref = post === null ? null : postRefOf(post)

  if (ref === null) return err({ _tag: "no-post" })

  return ok({ _tag: "post", post: ref })
}

/**
 * Decide what a Capture shows and which part of the page to crop, or why there is no Capture.
 *
 * @param input - How the Capture was started, where it goes, the page's address, the current
 *   time and the page layout to measure it in.
 * @returns The plan for the Capture, or the reason it is refused.
 */
export function planCapture(input: {
  /** The page being captured. For a Post Capture, the clicked Post's own status page. */
  readonly page: Document
  readonly start: CaptureStart
  readonly destination: Destination

  /** The address of the page being captured. */
  readonly url: URL

  /** When the Capture was taken; a Download's filename gives it in local time. */
  readonly now: Date
  readonly layout: Layout
}): Result<CapturePlan, CaptureRefusal> {
  const { layout } = input
  const targeted = targetOf(input)

  if (targeted._tag === "err") return targeted

  const target = targeted.value
  const bounds = boundsAround(target.map(layout.boundsOf))

  if (bounds.height * CAPTURE_SCALE > MAX_IMAGE_HEIGHT) return err({ _tag: "oversized" })

  return ok({
    target,
    clutter: target.flatMap((element) => (containsPost(element) ? clutterIn(element) : [])),
    crop: {
      x: bounds.x + layout.scroll.x,
      y: bounds.y + layout.scroll.y,
      width: bounds.width,
      height: bounds.height,
    },
    destination: planDestination(input),
    expand: input.start._tag === "post" ? showMoreIn(target) : [],
    warnings: warningsOf({ start: input.start, target }),
  })
}

/**
 * What the Capture shows: the picked element, or the Conversation ending at the Focal post of
 * the clicked Post's status page.
 */
function targetOf(input: {
  readonly page: Document
  readonly start: CaptureStart
}): Result<Target, CaptureRefusal> {
  const { page, start } = input

  switch (start._tag) {
    case "pick":
      return ok([start.element])
    case "post": {
      const focal = focalPost(page)

      // A Post's id is unique on X, while its handle can change or differ in case.
      if (focal === null || postRefOf(focal)?.postId !== start.post.postId) {
        return err({ _tag: "post-not-shown" })
      }

      return ok(conversationOf(focal))
    }
  }
}

/**
 * Why the Capture is a Partial Capture. A Pick Capture shows what was picked as rendered, so
 * only a Post Capture's Conversation is checked for Posts X couldn't show and for text it
 * shortened. A Post Capture is planned again after expanding, so Truncated text still there
 * then is text that expanding failed to show.
 */
function warningsOf(input: {
  readonly start: CaptureStart
  readonly target: Target
}): ReadonlyArray<CaptureWarning> {
  if (input.start._tag === "pick") return []

  const warnings: CaptureWarning[] = []

  if (continuesFromAbove(input.target[0])) warnings.push({ _tag: "root-post-missing" })

  const unavailable = input.target.filter(isPlaceholder).length

  if (unavailable > 0) warnings.push({ _tag: "unavailable-posts", count: unavailable })

  if (showMoreIn(input.target).length > 0) warnings.push({ _tag: "not-expanded" })

  if (cutOffQuotedPostsIn(input.target).length > 0) {
    warnings.push({ _tag: "quoted-post-cut-off" })
  }

  return warnings
}

/** The smallest rectangle around all of the given rectangles. */
function boundsAround(rects: ReadonlyArray<Rect>): Rect {
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))

  return { x: left, y: top, width: right - left, height: bottom - top }
}

function planDestination(input: {
  readonly start: CaptureStart
  readonly destination: Destination
  readonly url: URL
  readonly now: Date
}): DestinationPlan {
  switch (input.destination) {
    case "clipboard":
      return { _tag: "clipboard" }
    case "download":
      return { _tag: "download", filename: downloadFilename(input) }
  }
}

/**
 * A Download's filename: a Post Capture is named after the right-clicked Post, a Pick Capture
 * after the site and the local time it was taken.
 */
function downloadFilename(input: {
  readonly start: CaptureStart
  readonly url: URL
  readonly now: Date
}): string {
  const { start } = input

  switch (start._tag) {
    case "pick":
      return `xshot-${site(input.url)}-${timestamp(input.now)}.png`
    case "post":
      return `xshot-${start.post.handle}-${start.post.postId}.png`
  }
}

/** The page's host name without a leading "www.", or "page" for an address without one. */
function site(url: URL): string {
  const host = url.hostname.replace(/^www\./, "")

  return host === "" ? "page" : host
}

/** The local date and time as `YYYYMMDD-HHMMSS`, which sorts by time and is safe in filenames. */
function timestamp(now: Date): string {
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(twoDigits).join("")
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(twoDigits).join("")

  return `${date}-${time}`
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0")
}
