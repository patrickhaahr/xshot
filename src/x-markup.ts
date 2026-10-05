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

/** One item of X's virtualised lists, such as a Post on a status page. */
const CELL = '[data-testid="cellInnerDiv"]'

/** A Post or a placeholder X shows instead of a Post it can't show, such as a deleted one. */
const POST_OR_PLACEHOLDER = "article"

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
 * The Conversation a status page shows above its Focal post, down to and including it. Each
 * Post sits in its own list cell, and the cells before the Focal post's cell are the Posts it
 * replies to, root first. The Replies below are left out, and so is the reply composer, which
 * shares the Focal post's cell.
 *
 * @param focal - The Focal post.
 * @returns The Posts from the root down to the Focal post, in order, including placeholders for
 *   Posts X shows as unavailable.
 */
export function conversationOf(focal: Element): readonly [Element, ...Element[]] {
  const conversation: [Element, ...Element[]] = [focal]
  let cell = focal.closest(CELL)?.previousElementSibling ?? null

  for (; cell !== null; cell = cell.previousElementSibling) {
    const item = cell.matches(CELL) ? cell.querySelector(POST_OR_PLACEHOLDER) : null

    if (item !== null) conversation.unshift(item)
  }

  return conversation
}

/**
 * Whether a Conversation item is X's placeholder for a Post it can't show, such as an
 * unavailable or deleted Post, rather than a Post.
 *
 * @param item - A Post or placeholder from `conversationOf`.
 * @returns True for a placeholder.
 */
export function isPlaceholder(item: Element): boolean {
  return !item.matches(POST)
}

/**
 * X's "Show more" control at the end of a Truncated Post's text. It is a button that expands
 * the text in place and then disappears. Quoted posts never have one.
 */
const SHOW_MORE = '[data-testid="tweet-text-show-more-link"]'

/**
 * The "Show more" controls of the Truncated Posts among the given ones.
 *
 * @param posts - Posts, such as a Conversation; placeholders have no text to expand.
 * @returns The controls in page order.
 */
export function showMoreIn(posts: ReadonlyArray<Element>): Element[] {
  return posts.flatMap((post) => [...post.querySelectorAll(SHOW_MORE)])
}

/**
 * A quoted post's text. A quoted post is a link card inside the Post that quotes it, with its
 * own author name; the Post's own text is outside the card.
 */
const QUOTED_POST_TEXT = 'div[role="link"]:has([data-testid="User-Name"]) [data-testid="tweetText"]'

/**
 * The shortest quoted post text that is taken as cut off. X shows only about the
 * first 280 characters of a quoted post, with no "Show more" and no ellipsis: cut-off texts
 * ran 275 to 279 characters in saved pages, complete ones at most 217.
 */
const QUOTED_POST_SHOWN_LENGTH = 260

/**
 * The quoted posts X has cut off in the given Posts. Their text can't be expanded.
 *
 * @param posts - Posts, such as a Conversation.
 * @returns The cut-off quoted posts' texts in page order.
 */
export function cutOffQuotedPostsIn(posts: ReadonlyArray<Element>): Element[] {
  return posts
    .flatMap((post) => [...post.querySelectorAll(QUOTED_POST_TEXT)])
    .filter((text) => (text.textContent ?? "").length >= QUOTED_POST_SHOWN_LENGTH)
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
