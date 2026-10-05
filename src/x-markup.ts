// Everything XShot knows about X's rendered markup and addresses. X changes its markup without
// notice, so no other module holds an X selector: when a saved page stops matching, this is
// the file to update.

/** A Post's author handle and id, which name its status page. */
export type PostRef = {
  /** The author's handle, without the "@". */
  readonly handle: string

  /** The Post's numeric id, kept as a string because it exceeds a safe integer. */
  readonly postId: string
}

/** X's pages, as match patterns. static/manifest.json repeats them for the page script. */
export const X_PAGES = ["https://x.com/*", "https://twitter.com/*"]

/**
 * The address of a Post's own status page.
 *
 * @param post - The Post.
 * @returns Its status page on x.com.
 */
export function statusPageUrl(post: PostRef): string {
  return `https://x.com/${post.handle}/status/${post.postId}`
}

/**
 * A Post. Unavailable and deleted placeholders are articles too, but without this test id.
 * A quoted post is not an article but a link card inside the Post that quotes it.
 */
const POST = 'article[data-testid="tweet"]'

/**
 * The Focal post of a status page: X takes it out of the tab order, unlike every other Post.
 * Placeholders are out of the tab order too, which is why the Post test id is required.
 */
const FOCAL_POST = `${POST}[tabindex="-1"]`

/** A Post's own permalink is the only status link around a timestamp; a quoted post's timestamp has no link. */
const PERMALINK_TIME = 'a[href*="/status/"] time'

/** `/<handle>/status/<postId>`, the path of a Post's status page. */
const STATUS_PATH = /^\/(?<handle>\w{1,15})\/status\/(?<postId>\d+)$/

/**
 * The Post an element belongs to. Inside a quoted post, that is the Post that quotes it.
 *
 * @param element - Any element on an X page.
 * @returns The Post containing the element, or null when it isn't part of one.
 */
export function postContaining(element: Element): Element | null {
  return element.closest(POST)
}

/**
 * The Post a status page is about.
 *
 * @param page - An X page.
 * @returns The Focal post, or null on a page that isn't a status page or hasn't rendered it.
 */
export function focalPost(page: ParentNode): Element | null {
  return page.querySelector(FOCAL_POST)
}

/**
 * Which Post a Post element shows, read from its permalink. In a repost, that is the original
 * Post, not the repost.
 *
 * @param post - A Post element.
 * @returns The Post's handle and id, or null when it has no recognisable permalink.
 */
export function postRefOf(post: Element): PostRef | null {
  const href = post.querySelector(PERMALINK_TIME)?.closest("a")?.getAttribute("href")

  if (href === null || href === undefined) return null

  const groups = STATUS_PATH.exec(new URL(href, "https://x.com").pathname)?.groups
  const handle = groups?.["handle"]
  const postId = groups?.["postId"]

  if (handle === undefined || postId === undefined) return null

  return { handle, postId }
}

/**
 * Page interface inside a Post that isn't content: the "…" menu, the Grok actions button next
 * to it, and "Show translation" (formerly the "Translate post" link). `caret` also marks trend
 * menus in the sidebar, so it only counts inside a Post.
 */
const POST_CLUTTER = [
  '[data-testid="caret"]',
  'button[aria-label="Grok actions"]',
  'button[aria-label="Show translation"]',
].join(", ")

/**
 * Page interface around Posts that isn't content: the reply composer, which shares the Focal
 * post's cell, and the "Relevant people" section in the sidebar. The home timeline's own
 * composer is not a reply composer and stays. "Discover more" is not recognised: no saved page
 * shows it.
 */
const PAGE_CLUTTER = [
  '[data-testid="inline_reply_offscreen"]',
  'aside[aria-label="Relevant people"]',
].join(", ")

/**
 * Whether a Target is or contains a Post, which is when its Clutter is removed.
 *
 * @param target - What a Capture shows.
 * @returns True when the Target is a Post or has one inside it.
 */
export function containsPost(target: Element): boolean {
  return target.matches(POST) || target.querySelector(POST) !== null
}

/**
 * The Clutter in a Target.
 *
 * @param target - What a Capture shows.
 * @returns The elements to take out of the layout so the Capture shows no Clutter, each the
 *   outermost element that holds nothing else.
 */
export function clutterIn(target: Element): ReadonlyArray<Element> {
  const posts = target.matches(POST) ? [target] : [...target.querySelectorAll(POST)]

  const inPosts = posts.flatMap((post) =>
    [...post.querySelectorAll(POST_CLUTTER)].map((control) => wholeControl(control, post))
  )

  const aroundPosts = [...target.querySelectorAll(PAGE_CLUTTER)].map((section) =>
    wholeControl(section, target)
  )

  return [...inPosts, ...aroundPosts]
}

/**
 * A control together with the wrappers and icons that are there only for it, such as the
 * translation icon in front of "Show translation", so removing it leaves neither a stray icon
 * nor a wrapper's spacing behind.
 *
 * @param control - A piece of Clutter.
 * @param within - The element the control is in, which is never part of it.
 * @returns The outermost element inside `within` that holds the control and nothing else.
 */
function wholeControl(control: Element, within: Element): Element {
  let whole = control

  while (
    whole.parentElement !== null &&
    whole.parentElement !== within &&
    holdsOnly(whole.parentElement, whole)
  ) {
    whole = whole.parentElement
  }

  return whole
}

/** Whether `parent` holds nothing but `child` and icons: no other element and no text. */
function holdsOnly(parent: Element, child: Element): boolean {
  return [...parent.childNodes].every((node) => {
    if (node === child) return true

    switch (node.nodeType) {
      case Node.ELEMENT_NODE:
        return node.nodeName.toLowerCase() === "svg"
      case Node.TEXT_NODE:
        return (node.textContent ?? "").trim() === ""
      default:
        return true
    }
  })
}
