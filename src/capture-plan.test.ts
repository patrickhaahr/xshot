import { afterAll, beforeAll, expect, test } from "bun:test"

import { GlobalRegistrator } from "@happy-dom/global-registrator"

import { planCapture, startPostCapture } from "./capture-plan"
import type { CapturePlan, CaptureRefusal, Layout, Rect } from "./capture-plan"

// Never pass an Element to expect(), not even to toBe: when the assertion fails, bun formats
// the happy-dom node with the whole DOM graph behind it, which exhausts memory. Compare
// Elements with expectSameElement(s) and plain data with toEqual.

beforeAll(() => {
  GlobalRegistrator.register({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function loadSavedPage(name: string): Promise<Document> {
  const html = await Bun.file(new URL(`../fixtures/pages/${name}`, import.meta.url)).text()

  return new DOMParser().parseFromString(html, "text/html")
}

function select(page: Document, selector: string): Element {
  const element = page.querySelector(selector)

  if (element === null) throw new Error(`The saved page has no ${selector}`)

  return element
}

/** A layout that places the given elements where the test says and everything else nowhere. */
function layoutOf(
  bounds: ReadonlyArray<readonly [Element, Rect]>,
  scroll: Layout["scroll"]
): Layout {
  const byElement = new Map(bounds)

  return {
    boundsOf: (element) => byElement.get(element) ?? { x: 0, y: 0, width: 0, height: 0 },
    scroll,
  }
}

/** Fail unless `actual` is `expected`, describing both briefly instead of formatting the DOM. */
function expectSameElement(actual: Element | undefined, expected: Element): void {
  if (actual === expected) return

  throw new Error(`Expected ${describeElement(expected)}, got ${describeElement(actual)}`)
}

/** Fail unless `actual` holds exactly the `expected` elements, in order. */
function expectSameElements(
  actual: ReadonlyArray<Element>,
  expected: ReadonlyArray<Element>
): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `Expected [${expected.map(describeElement).join(", ")}], got [${actual.map(describeElement).join(", ")}]`
    )
  }

  expected.forEach((element, i) => {
    expectSameElement(actual[i], element)
  })
}

function describeElement(element: Element | undefined): string {
  if (element === undefined) return "no element"

  const testId = element.getAttribute("data-testid")
  const text = (element.textContent ?? "").trim().slice(0, 60)

  return `<${element.localName}${testId === null ? "" : ` data-testid="${testId}"`}> "${text}"`
}

function planOf(planned: ReturnType<typeof planCapture>): CapturePlan {
  if (planned._tag !== "ok") throw new Error(`Expected a plan, got ${planned.error._tag}`)

  return planned.value
}

function refusalOf(planned: ReturnType<typeof planCapture>): CaptureRefusal {
  if (planned._tag !== "err") throw new Error("Expected a refusal, got a plan")

  return planned.error
}

test("a Pick Capture crops the whole picked element in document coordinates, beyond the viewport", async () => {
  const page = await loadSavedPage("wikipedia-screenshot.html")
  const figure = select(page, "figure#mwBQ")

  // Scrolled 1,200 px down a 900 px tall viewport: the figure starts 300.5 px above the
  // viewport and ends well below it.
  const layout = layoutOf([[figure, { x: 960.25, y: -300.5, width: 222, height: 1800.75 }]], {
    x: 0,
    y: 1200,
  })

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "pick", element: figure },
      destination: "clipboard",
      url: new URL("https://en.wikipedia.org/wiki/Screenshot"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout,
    })
  )

  expectSameElements(plan.target, [figure])
  expect(plan.crop).toEqual({ x: 960.25, y: 899.5, width: 222, height: 1800.75 })
})

test("a Target over 8,192 CSS px tall is refused as Oversized", async () => {
  const page = await loadSavedPage("wikipedia-screenshot.html")
  const article = select(page, "#mw-content-text")

  // 8,192.5 CSS px is 16,385 image px at 2x, one past the tallest image Chromium can produce.
  const layout = layoutOf([[article, { x: 0, y: 0, width: 960, height: 8192.5 }]], { x: 0, y: 0 })

  const refusal = refusalOf(
    planCapture({
      page,
      start: { _tag: "pick", element: article },
      destination: "clipboard",
      url: new URL("https://en.wikipedia.org/wiki/Screenshot"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout,
    })
  )

  expect(refusal).toEqual({ _tag: "oversized" })
})

test("a Target exactly 8,192 CSS px tall is planned", async () => {
  const page = await loadSavedPage("wikipedia-screenshot.html")
  const article = select(page, "#mw-content-text")
  const layout = layoutOf([[article, { x: 0, y: 40, width: 960, height: 8192 }]], { x: 0, y: 0 })

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "pick", element: article },
      destination: "clipboard",
      url: new URL("https://en.wikipedia.org/wiki/Screenshot"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout,
    })
  )

  expectSameElements(plan.target, [article])
  expect(plan.crop).toEqual({ x: 0, y: 40, width: 960, height: 8192 })
})

test("a Pick Capture to a Download is named after the site and the local time it was taken", async () => {
  const page = await loadSavedPage("wikipedia-screenshot.html")
  const figure = select(page, "figure#mwBQ")

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "pick", element: figure },
      destination: "download",
      url: new URL("https://en.wikipedia.org/wiki/Screenshot"),
      // Built from local date parts, so the expected name holds in any time zone.
      now: new Date(2026, 9, 5, 9, 8, 7),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )

  expect(plan.destination).toEqual({
    _tag: "download",
    filename: "xshot-en.wikipedia.org-20261005-090807.png",
  })
})

test("a Pick Capture to the Clipboard has no filename", async () => {
  const page = await loadSavedPage("wikipedia-screenshot.html")
  const figure = select(page, "figure#mwBQ")

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "pick", element: figure },
      destination: "clipboard",
      url: new URL("https://en.wikipedia.org/wiki/Screenshot"),
      now: new Date(2026, 9, 5, 9, 8, 7),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )

  expect(plan.destination).toEqual({ _tag: "clipboard" })
})

test("a Download's site leaves out a leading www.", async () => {
  const page = await loadSavedPage("wikipedia-screenshot.html")
  const figure = select(page, "figure#mwBQ")

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "pick", element: figure },
      destination: "download",
      url: new URL("https://www.wikipedia.org/"),
      now: new Date(2026, 11, 31, 23, 59, 59),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )

  expect(plan.destination).toEqual({
    _tag: "download",
    filename: "xshot-wikipedia.org-20261231-235959.png",
  })
})

test("a Download from a page without a host name is named after the page", async () => {
  const page = await loadSavedPage("wikipedia-screenshot.html")
  const figure = select(page, "figure#mwBQ")

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "pick", element: figure },
      destination: "download",
      url: new URL("file:///home/me/wikipedia-screenshot.html"),
      now: new Date(2026, 0, 1, 0, 0, 0),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )

  expect(plan.destination).toEqual({
    _tag: "download",
    filename: "xshot-page-20260101-000000.png",
  })
})

/** The `index`th element matching `selector`, counting from 0. */
function nth(page: Document, selector: string, index: number): Element {
  const element = page.querySelectorAll(selector).item(index)

  if (element === null) throw new Error(`The saved page has no ${selector} number ${index}`)

  return element
}

test("right-clicking a Post's text in a timeline starts a Post Capture of that Post", async () => {
  const page = await loadSavedPage("x-timeline.html")
  const text = nth(page, '[data-testid="tweetText"]', 0)

  expect(startPostCapture(text)).toEqual({
    _tag: "ok",
    value: { _tag: "post", post: { handle: "JakeSucky", postId: "2107138752770433355" } },
  })
})

test("right-clicking inside a quoted post starts a Post Capture of the Post that quotes it", async () => {
  const page = await loadSavedPage("x-status-quote.html")
  // The Focal post's second text is the quoted Mikkel_Bjorn post's.
  const quotedText = nth(page, '[data-testid="tweetText"]', 1)

  expect(startPostCapture(quotedText)).toEqual({
    _tag: "ok",
    value: { _tag: "post", post: { handle: "AllanFeldt_", postId: "2107159689482100881" } },
  })
})

test("right-clicking a repost's 'reposted' line starts a Post Capture of the original Post", async () => {
  const page = await loadSavedPage("x-timeline.html")
  // "sunil pai reposted" a LukyVJ Post.
  const reposted = nth(page, '[data-testid="socialContext"]', 0)

  expect(startPostCapture(reposted)).toEqual({
    _tag: "ok",
    value: { _tag: "post", post: { handle: "LukyVJ", postId: "2107072041358631139" } },
  })
})

test("right-clicking a Post above the Focal post in a thread starts a Post Capture of that Post", async () => {
  const page = await loadSavedPage("x-status-deep-reply.html")
  // The thread's second Post, a Reply to the root.
  const replyText = nth(page, '[data-testid="tweetText"]', 1)

  expect(startPostCapture(replyText)).toEqual({
    _tag: "ok",
    value: { _tag: "post", post: { handle: "BrandonLuuMD", postId: "2100910325746782296" } },
  })
})

test("right-clicking outside a Post is refused as No Post here", async () => {
  const page = await loadSavedPage("x-status-original.html")
  const relevantPeople = select(page, 'aside[aria-label="Relevant people"]')
  const replyComposer = select(page, '[data-testid="inline_reply_offscreen"]')

  expect(startPostCapture(relevantPeople)).toEqual({ _tag: "err", error: { _tag: "no-post" } })
  expect(startPostCapture(replyComposer)).toEqual({ _tag: "err", error: { _tag: "no-post" } })
})

test("a Post Capture of a Reply captures its Conversation from the root Post down to it, and nothing below", async () => {
  const page = await loadSavedPage("x-status-deep-reply.html")
  // The thread's root and three Replies are above the Focal post, the fifth article; two more
  // Replies follow it.
  const root = nth(page, "article", 0)
  const second = nth(page, "article", 1)
  const third = nth(page, "article", 2)
  const fourth = nth(page, "article", 3)
  const focalPost = nth(page, "article", 4)
  const focalCell = nth(page, '[data-testid="cellInnerDiv"]', 4)
  const replyBelow = nth(page, "article", 5)

  // Scrolled 1,500 px down: the root starts 1,200 px above the viewport. The Focal post's cell
  // also holds the reply composer below the Focal post.
  const layout = layoutOf(
    [
      [root, { x: 600, y: -1200, width: 598, height: 432.25 }],
      [second, { x: 600, y: -767.75, width: 598, height: 197.25 }],
      [third, { x: 600, y: -570.5, width: 598, height: 521.5 }],
      [fourth, { x: 600, y: -49, width: 598, height: 561.75 }],
      [focalPost, { x: 600, y: 512.75, width: 598, height: 412.25 }],
      [focalCell, { x: 600, y: 512.75, width: 598, height: 734.5 }],
      [replyBelow, { x: 600, y: 1247.25, width: 598, height: 237.5 }],
    ],
    { x: 0, y: 1500 }
  )

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "post", post: { handle: "BrandonLuuMD", postId: "2100910333376278960" } },
      destination: "clipboard",
      url: new URL("https://x.com/BrandonLuuMD/status/2100910333376278960"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout,
    })
  )

  expectSameElements(plan.target, [root, second, third, fourth, focalPost])
  // From the root's top to the Focal post's bottom, above the reply composer.
  expect(plan.crop).toEqual({ x: 600, y: 300, width: 598, height: 2125 })
  expect(plan.warnings).toEqual([])
})

test("a Post Capture of an original Post captures only that Post, without the reply composer", async () => {
  const page = await loadSavedPage("x-status-original.html")
  // The Focal post is the first article; its cell also holds the reply composer, and Replies follow.
  const focalPost = nth(page, "article", 0)
  const focalCell = nth(page, '[data-testid="cellInnerDiv"]', 0)
  const firstReply = nth(page, "article", 1)

  const layout = layoutOf(
    [
      [focalPost, { x: 600, y: 53, width: 598, height: 250.5 }],
      [focalCell, { x: 600, y: 53, width: 598, height: 327.25 }],
      [firstReply, { x: 600, y: 380.25, width: 598, height: 118.75 }],
    ],
    { x: 0, y: 0 }
  )

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "post", post: { handle: "yacineMTB", postId: "2107133825360761293" } },
      destination: "clipboard",
      url: new URL("https://x.com/yacineMTB/status/2107133825360761293"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout,
    })
  )

  expectSameElements(plan.target, [focalPost])
  expect(plan.crop).toEqual({ x: 600, y: 53, width: 598, height: 250.5 })
})

test("a Post Capture of a Reply below an unavailable Post keeps X's placeholder as a Partial Capture", async () => {
  const page = await loadSavedPage("x-status-unavailable.html")
  // The root is X's "This Post is unavailable." placeholder, then two Posts, then the Focal post.
  const placeholder = nth(page, "article", 0)
  const second = nth(page, "article", 1)
  const third = nth(page, "article", 2)
  const focalPost = nth(page, "article", 3)

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "post", post: { handle: "koftaThunder", postId: "2107158042852684071" } },
      destination: "clipboard",
      url: new URL("https://x.com/koftaThunder/status/2107158042852684071"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )

  expectSameElements(plan.target, [placeholder, second, third, focalPost])
  expect(plan.warnings).toEqual([{ _tag: "unavailable-posts", count: 1 }])
})

test("a Conversation over 8,192 CSS px tall is refused as Oversized, though each Post fits", async () => {
  const page = await loadSavedPage("x-status-deep-reply.html")
  const root = nth(page, "article", 0)
  const focalPost = nth(page, "article", 4)

  const layout = layoutOf(
    [
      [root, { x: 600, y: 0, width: 598, height: 4000 }],
      [focalPost, { x: 600, y: 4000, width: 598, height: 4192.5 }],
    ],
    { x: 0, y: 0 }
  )

  const refusal = refusalOf(
    planCapture({
      page,
      start: { _tag: "post", post: { handle: "BrandonLuuMD", postId: "2100910333376278960" } },
      destination: "clipboard",
      url: new URL("https://x.com/BrandonLuuMD/status/2100910333376278960"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout,
    })
  )

  expect(refusal).toEqual({ _tag: "oversized" })
})

test("a Pick Capture of an unavailable Post's placeholder is not a Partial Capture", async () => {
  const page = await loadSavedPage("x-status-unavailable.html")
  const placeholder = nth(page, "article", 0)

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "pick", element: placeholder },
      destination: "clipboard",
      url: new URL("https://x.com/koftaThunder/status/2107158042852684071"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )

  expect(plan.warnings).toEqual([])
})

test("a Partial Capture counts every deleted Post's placeholder in the Conversation", async () => {
  const page = await loadSavedPage("x-status-deleted.html")
  // Eight items above the Focal post, the ninth article; the second and sixth are "This Post
  // was deleted by the Post author." placeholders.
  const conversation = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => nth(page, "article", index))

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "post", post: { handle: "gladeslamek", postId: "2107130327399387612" } },
      destination: "clipboard",
      url: new URL("https://x.com/gladeslamek/status/2107130327399387612"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )

  expectSameElements(plan.target, conversation)
  expect(plan.warnings).toEqual([{ _tag: "unavailable-posts", count: 2 }])
})

test("a Post Capture to a Download is named after the right-clicked Post's handle and id", async () => {
  const page = await loadSavedPage("x-status-deep-reply.html")

  const plan = planOf(
    planCapture({
      page,
      start: { _tag: "post", post: { handle: "BrandonLuuMD", postId: "2100910333376278960" } },
      destination: "download",
      url: new URL("https://x.com/BrandonLuuMD/status/2100910333376278960"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )

  expect(plan.destination).toEqual({
    _tag: "download",
    filename: "xshot-BrandonLuuMD-2100910333376278960.png",
  })
})

test("a Post Capture is refused when the status page's Focal post is another Post", async () => {
  const page = await loadSavedPage("x-status-quote.html")

  // The quoted Mikkel_Bjorn post: the page shows it inside the Focal post, not as the Focal post.
  const refusal = refusalOf(
    planCapture({
      page,
      start: { _tag: "post", post: { handle: "Mikkel_Bjorn", postId: "2106788303831744795" } },
      destination: "clipboard",
      url: new URL("https://x.com/AllanFeldt_/status/2107159689482100881"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )

  expect(refusal).toEqual({ _tag: "post-not-shown" })
})

test("a Post Capture is refused on a page without a Focal post", async () => {
  const page = await loadSavedPage("x-timeline.html")

  const refusal = refusalOf(
    planCapture({
      page,
      start: { _tag: "post", post: { handle: "JakeSucky", postId: "2107138752770433355" } },
      destination: "clipboard",
      url: new URL("https://x.com/home"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )

  expect(refusal).toEqual({ _tag: "post-not-shown" })
})

test("right-clicking an unavailable Post's placeholder is refused as No Post here", async () => {
  const page = await loadSavedPage("x-status-unavailable.html")
  const placeholder = nth(page, "article", 0)

  expect(startPostCapture(placeholder)).toEqual({ _tag: "err", error: { _tag: "no-post" } })
})
