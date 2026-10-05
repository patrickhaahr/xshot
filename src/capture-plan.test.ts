import { afterAll, beforeAll, expect, test } from "bun:test"

import { GlobalRegistrator } from "@happy-dom/global-registrator"

import { planCapture, startPostCapture } from "./capture-plan"
import type { CapturePlan, CaptureRefusal, Layout, Rect } from "./capture-plan"
import type { PostRef } from "./x-markup"

// Never pass an Element to expect(), not even to toBe: when the assertion fails, bun formats
// the happy-dom node with the whole DOM graph behind it, which exhausts memory. Compare
// Elements with expectSameElement and plain data with toEqual.

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

  expectSameElement(plan.target, figure)
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

  expectSameElement(plan.target, article)
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

test("a Post Capture of a Reply captures the Focal post of its status page", async () => {
  const page = await loadSavedPage("x-status-deep-reply.html")
  // Four Posts of the thread are above the Focal post, the fifth article.
  const focalPost = nth(page, "article", 4)

  const layout = layoutOf([[focalPost, { x: 600, y: -120.5, width: 598, height: 412.25 }]], {
    x: 0,
    y: 1500,
  })

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

  expectSameElement(plan.target, focalPost)
  expect(plan.crop).toEqual({ x: 600, y: 1379.5, width: 598, height: 412.25 })
})

test("a Post Capture finds the Focal post below an unavailable Post's placeholder", async () => {
  const page = await loadSavedPage("x-status-unavailable.html")
  // The placeholder, two Posts, then the Focal post as the fourth article.
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

  expectSameElement(plan.target, focalPost)
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

/**
 * How many elements matching `selector` the Capture shows: those in the Target, the Target
 * included, that aren't inside Clutter the plan removes.
 */
function shownCount(plan: CapturePlan, selector: string): number {
  const inTarget = [plan.target, ...plan.target.querySelectorAll(selector)].filter((element) =>
    element.matches(selector)
  )

  return inTarget.filter((element) => isShown(plan, element)).length
}

/** Whether the Capture shows an element: it is in the Target and not inside removed Clutter. */
function isShown(plan: CapturePlan, element: Element): boolean {
  return plan.target.contains(element) && !plan.clutter.some((removed) => removed.contains(element))
}

/** Plan a Post Capture of the Focal post of a saved status page. */
async function planFocalPostCapture(name: string, post: PostRef): Promise<CapturePlan> {
  const page = await loadSavedPage(name)

  return planOf(
    planCapture({
      page,
      start: { _tag: "post", post },
      destination: "clipboard",
      url: new URL(`https://x.com/${post.handle}/status/${post.postId}`),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )
}

test("a Post Capture removes the Post's '…' menu and Grok actions buttons", async () => {
  const plan = await planFocalPostCapture("x-status-deep-reply.html", {
    handle: "BrandonLuuMD",
    postId: "2100910333376278960",
  })

  expect(shownCount(plan, '[data-testid="caret"]')).toBe(0)
  expect(shownCount(plan, 'button[aria-label="Grok actions"]')).toBe(0)
})

test("a Post Capture removes the 'Show translation' button together with its icon", async () => {
  const plan = await planFocalPostCapture("x-status-quote.html", {
    handle: "AllanFeldt_",
    postId: "2107159689482100881",
  })

  const translate = select(plan.target.ownerDocument, 'button[aria-label="Show translation"]')
  // The translation icon in front of the button is its sibling, not inside it.
  const icon = translate.previousElementSibling

  expect(isShown(plan, translate)).toBe(false)
  expect(icon === null ? "no icon" : isShown(plan, icon)).toBe(false)
  // The Post's text and the quoted post's text stay.
  expect(shownCount(plan, '[data-testid="tweetText"]')).toBe(2)
})

test("a Post Capture keeps the engagement counts, the timestamp and the community note", async () => {
  const plan = await planFocalPostCapture("x-status-community-note.html", {
    handle: "realDonaldTrump",
    postId: "2106395048015282265",
  })

  expect(plan.clutter.length).toBeGreaterThan(0)
  expect(shownCount(plan, 'div[role="group"][aria-label*="views"]')).toBe(1)
  expect(
    shownCount(plan, '[data-testid="reply"], [data-testid="retweet"], [data-testid="like"]')
  ).toBe(3)
  expect(shownCount(plan, "time")).toBe(1)
  expect(shownCount(plan, '[data-testid="birdwatch-pivot"]')).toBe(1)
})

test("a Post Capture keeps a community note inside the quoted post", async () => {
  const plan = await planFocalPostCapture("x-status-quote-community-note.html", {
    handle: "pepelkoklisarot",
    postId: "2107035042731999591",
  })

  expect(plan.clutter.length).toBeGreaterThan(0)
  expect(shownCount(plan, '[data-testid="birdwatch-pivot"]')).toBe(1)
  // The Post's timestamp and the quoted post's.
  expect(shownCount(plan, "time")).toBe(2)
})

/** Plan a Pick Capture of an element on a saved X page. */
function planPickCapture(element: Element): CapturePlan {
  return planOf(
    planCapture({
      page: element.ownerDocument,
      start: { _tag: "pick", element },
      destination: "clipboard",
      url: new URL("https://x.com/"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout: layoutOf([], { x: 0, y: 0 }),
    })
  )
}

test("a Pick Capture of the Focal post's cell removes the reply composer and the Post's Clutter", async () => {
  const page = await loadSavedPage("x-status-original.html")
  const composer = select(page, '[data-testid="inline_reply_offscreen"]')
  const focalCell = composer.closest('[data-testid="cellInnerDiv"]')

  if (focalCell === null) throw new Error("The reply composer isn't in a cell")

  const plan = planPickCapture(focalCell)

  expect(isShown(plan, composer)).toBe(false)
  expect(shownCount(plan, '[data-testid="caret"], button[aria-label="Grok actions"]')).toBe(0)
  expect(shownCount(plan, 'article[data-testid="tweet"]')).toBe(1)
})

test("a Pick Capture of a whole status page removes 'Relevant people' with its frame", async () => {
  const page = await loadSavedPage("x-status-original.html")
  const relevantPeople = select(page, 'aside[aria-label="Relevant people"]')
  // The bordered box around the section, which would otherwise stay as an empty frame.
  const frame = relevantPeople.parentElement

  const plan = planPickCapture(page.body)

  expect(isShown(plan, relevantPeople)).toBe(false)
  expect(frame === null ? "no frame" : isShown(plan, frame)).toBe(false)
  // 30 of the page's 34 "…" menus are in Posts; the other 4, on trends in the sidebar, stay.
  expect(shownCount(plan, '[data-testid="caret"]')).toBe(4)
  expect(shownCount(plan, '[data-testid="sidebarColumn"]')).toBe(1)
})

test("a Pick Capture without a Post is left as rendered, even around 'Relevant people'", async () => {
  const page = await loadSavedPage("x-status-original.html")

  const plan = planPickCapture(select(page, '[data-testid="sidebarColumn"]'))

  expect(plan.clutter.length).toBe(0)
})

test("a Pick Capture of a timeline removes every Post's Clutter but keeps the home composer", async () => {
  const page = await loadSavedPage("x-timeline.html")

  const plan = planPickCapture(select(page, '[data-testid="primaryColumn"]'))

  expect(shownCount(plan, 'article[data-testid="tweet"]')).toBe(17)
  expect(shownCount(plan, '[data-testid="caret"], button[aria-label="Grok actions"]')).toBe(0)
  expect(shownCount(plan, '[data-testid="tweetTextarea_0"]')).toBe(1)
})
