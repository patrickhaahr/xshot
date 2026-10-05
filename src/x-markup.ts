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
