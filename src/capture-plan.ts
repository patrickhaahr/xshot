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
  showsReplyingTo,
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
  | ConversationOfOneStart

/**
 * A Post Capture: the Post the user right-clicked, planned as the Focal post of the page it is
 * captured on. It is plain data, so it can travel to the Post's own status page; when the
 * right-clicked page is that status page, it is planned there instead.
 */
export type PostCaptureStart = { readonly _tag: "post"; readonly post: PostRef }

/**
 * A Post Capture of a Post that is a Conversation of one, planned on the page it was
 * right-clicked on: it is neither a Reply nor Truncated, so it shows there as on its status page.
 */
export type ConversationOfOneStart = {
  readonly _tag: "conversation-of-one"
  readonly post: PostRef

  /** The right-clicked Post. */
  readonly element: Element
}

/** Where the user asked for the Capture to go. */
export type Destination = "clipboard" | "download"

/** A Capture the user asked for: how it was started and where it goes. */
export type CaptureRequest = { readonly start: CaptureStart; readonly destination: Destination }

/**
 * A Post Capture the user asked for. It is plain data, so it can travel from the right-clicked
 * page to the Post's status page.
 */
export type PostCaptureRequest = {
  readonly start: PostCaptureStart
  readonly destination: Destination
}

/** Where a finished Capture is delivered, with what a Download needs. */
export type DestinationPlan =
  | { readonly _tag: "clipboard" }
  /** A PNG file in the downloads folder, saved under `filename`. */
  | { readonly _tag: "download"; readonly filename: string }

/**
 * How the browser rendered the page: the layout the plan reads and which images loaded. The
 * browser provides it; a test does, because happy-dom neither lays out nor loads images.
 */
export type Layout = {
  /** The element's border box relative to the viewport, as `getBoundingClientRect()` reports it. */
  readonly boundsOf: (element: Element) => Rect

  /** How far the document is scrolled, in CSS pixels. */
  readonly scroll: { readonly x: number; readonly y: number }

  /** Whether an image has loaded, rather than failed or still loading. */
  readonly imageLoaded: (image: Element) => boolean
}

/** What a Capture shows and where it is on the page. */
export type CapturePlan = {
  /**
   * What the Capture shows, top to bottom: the picked element, or the Conversation from its
   * root Post down to the Focal post or the Post that is a Conversation of one.
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
  /** Images in the Conversation that failed to load, or hadn't loaded in time. */
  | { readonly _tag: "images-not-loaded"; readonly count: number }

/** Why no Capture is taken. */
export type CaptureRefusal =
  /** The Target is too tall to fit in one image at full sharpness. */
  | { readonly _tag: "oversized" }
  /** A Post Capture was started somewhere that isn't a Post. */
  | { readonly _tag: "no-post" }
  /**
   * The page a Post Capture is measured on doesn't show the clicked Post, or not as its Focal
   * post, so it can't be captured.
   */
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
 * Where a Post Capture is measured. A page that already shows the right-clicked Post's whole
 * Conversation as its status page would is captured in place; otherwise the Post's status page
 * is opened in a background tab.
 */
export type PostCaptureSite =
  /** The right-clicked page shows the whole Conversation, so it is captured there. */
  | { readonly _tag: "in-place"; readonly start: PostCaptureStart | ConversationOfOneStart }
  /** Only the Post's own status page shows its Conversation in full. */
  | { readonly _tag: "status-page"; readonly start: PostCaptureStart }

/**
 * Start a Post Capture from the element under a right-click, and decide where it is measured.
 * The Focal post of the status page the user is on is captured in place, and so is a Post
 * elsewhere that is neither a Reply nor Truncated, its Conversation being just itself. Any other
 * Post Capture needs the status page: the Posts above a Reply aren't on this page, and a
 * Truncated Post in a timeline expands only on its status page.
 *
 * @param clicked - The element the user right-clicked.
 * @returns Where to capture the clicked Post, or "no-post" when the element isn't part of a Post.
 */
export function postCaptureSite(clicked: Element): Result<PostCaptureSite, CaptureRefusal> {
  const started = startPostCapture(clicked)
  const post = postContaining(clicked)

  if (started._tag === "err") return started

  if (post === null) return err({ _tag: "no-post" })

  const start = started.value
  const focal = focalPost(post.ownerDocument)

  if (focal === post) return ok({ _tag: "in-place", start })

  // On a status page, every other Post is in the Focal post's Conversation or below it, where
  // X shows a Reply without marking it as one.
  if (focal !== null || isReply(post) || showMoreIn([post]).length > 0) {
    return ok({ _tag: "status-page", start })
  }

  return ok({
    _tag: "in-place",
    start: { _tag: "conversation-of-one", post: start.post, element: post },
  })
}

/** Whether X marks a Post outside a status page as a Reply, with a line or a "Replying to" line. */
function isReply(post: Element): boolean {
  return continuesFromAbove(post) || showsReplyingTo(post)
}

/** What a Capture is planned from: the request, and the page it is taken on as rendered now. */
export type PlanInput = CaptureRequest & {
  /**
   * The page being captured. For a Post Capture, the clicked Post's own status page, or the
   * right-clicked page when it is captured in place.
   */
  readonly page: Document

  /** The address of the page being captured. */
  readonly url: URL

  /** When the Capture was taken; a Download's filename gives it in local time. */
  readonly now: Date
  readonly layout: Layout
}

/**
 * Decide what a Capture shows and which part of the page to crop, or why there is no Capture.
 *
 * @param input - How the Capture was started, where it goes, the page's address, the current
 *   time and how the page is rendered.
 * @returns The plan for the Capture, or the reason it is refused.
 */
export function planCapture(input: PlanInput): Result<CapturePlan, CaptureRefusal> {
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
    expand: input.start._tag === "pick" ? [] : showMoreIn(target),
    warnings: warningsOf(input, target),
  })
}

/**
 * What the Capture shows: the picked element, the Conversation ending at the Focal post of the
 * page it is captured on, or the right-clicked Post that is a Conversation of one.
 */
function targetOf(input: PlanInput): Result<Target, CaptureRefusal> {
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

    case "conversation-of-one": {
      const { element } = start

      // X's lists can replace a Post's element, or reuse it for another Post, as they re-render.
      if (!element.isConnected || postRefOf(element)?.postId !== start.post.postId) {
        return err({ _tag: "post-not-shown" })
      }

      return ok([element])
    }
  }
}

/**
 * Why the Capture is a Partial Capture. A Pick Capture shows what was picked as rendered, so
 * only a Post Capture's Conversation is checked for Posts X couldn't show, images that didn't
 * load and text X shortened. A Post Capture is planned again after expanding, so Truncated text
 * still there then is text that expanding failed to show.
 */
function warningsOf(input: PlanInput, target: Target): ReadonlyArray<CaptureWarning> {
  if (input.start._tag === "pick") return []

  const warnings: CaptureWarning[] = []

  if (continuesFromAbove(target[0])) warnings.push({ _tag: "root-post-missing" })

  const unavailable = target.filter(isPlaceholder).length

  if (unavailable > 0) warnings.push({ _tag: "unavailable-posts", count: unavailable })

  const notLoaded = target
    .flatMap((item) => [...item.querySelectorAll("img")])
    .filter((image) => !input.layout.imageLoaded(image)).length

  if (notLoaded > 0) warnings.push({ _tag: "images-not-loaded", count: notLoaded })

  if (showMoreIn(target).length > 0) warnings.push({ _tag: "not-expanded" })

  if (cutOffQuotedPostsIn(target).length > 0) warnings.push({ _tag: "quoted-post-cut-off" })

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

function planDestination(input: PlanInput): DestinationPlan {
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
function downloadFilename(input: PlanInput): string {
  const { start } = input

  switch (start._tag) {
    case "pick":
      return `xshot-${site(input.url)}-${timestamp(input.now)}.png`
    case "post":
    case "conversation-of-one":
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
