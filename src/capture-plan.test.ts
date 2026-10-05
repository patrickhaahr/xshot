import { afterAll, beforeAll, expect, test } from "bun:test"

import { GlobalRegistrator } from "@happy-dom/global-registrator"

import { planCapture } from "./capture-plan"
import type { CapturePlan, CaptureRefusal, Layout, Rect } from "./capture-plan"

// Never compare Elements with toEqual: a failing diff of a happy-dom node formats the whole
// DOM graph and can exhaust memory. Compare them with toBe and plain data with toEqual.

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
      start: { _tag: "pick", element: figure },
      destination: "clipboard",
      url: new URL("https://en.wikipedia.org/wiki/Screenshot"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout,
    })
  )

  expect(plan.target).toBe(figure)
  expect(plan.crop).toEqual({ x: 960.25, y: 899.5, width: 222, height: 1800.75 })
})

test("a Target over 8,192 CSS px tall is refused as Oversized", async () => {
  const page = await loadSavedPage("wikipedia-screenshot.html")
  const article = select(page, "#mw-content-text")

  // 8,192.5 CSS px is 16,385 image px at 2x, one past the tallest image Chromium can produce.
  const layout = layoutOf([[article, { x: 0, y: 0, width: 960, height: 8192.5 }]], { x: 0, y: 0 })

  const refusal = refusalOf(
    planCapture({
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
      start: { _tag: "pick", element: article },
      destination: "clipboard",
      url: new URL("https://en.wikipedia.org/wiki/Screenshot"),
      now: new Date(2026, 9, 5, 12, 38, 42),
      layout,
    })
  )

  expect(plan.target).toBe(article)
  expect(plan.crop).toEqual({ x: 0, y: 40, width: 960, height: 8192 })
})

test("a Pick Capture to a Download is named after the site and the local time it was taken", async () => {
  const page = await loadSavedPage("wikipedia-screenshot.html")
  const figure = select(page, "figure#mwBQ")

  const plan = planOf(
    planCapture({
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
