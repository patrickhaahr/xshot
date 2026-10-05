import { afterAll, beforeAll, expect, test } from "bun:test"

import { GlobalRegistrator } from "@happy-dom/global-registrator"

import { planCapture } from "./capture-plan"
import type { Layout, Rect } from "./capture-plan"

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

test("a Pick Capture crops the whole picked element in document coordinates, beyond the viewport", async () => {
  const page = await loadSavedPage("wikipedia-screenshot.html")
  const figure = select(page, "figure#mwBQ")

  // Scrolled 1,200 px down a 900 px tall viewport: the figure starts 300.5 px above the
  // viewport and ends well below it.
  const layout = layoutOf([[figure, { x: 960.25, y: -300.5, width: 222, height: 1800.75 }]], {
    x: 0,
    y: 1200,
  })

  const plan = planCapture({ start: { _tag: "pick", element: figure }, layout })

  expect(plan.target).toBe(figure)
  expect(plan.crop).toEqual({ x: 960.25, y: 899.5, width: 222, height: 1800.75 })
})
