import { planCapture, startPostCapture } from "./capture-plan"
import type { CaptureRequest, Destination, Layout, Rect, Target } from "./capture-plan"
import { dismissConfirmation, showConfirmation, showFailure, showRefusal } from "./confirmation"
import type { CaptureResponse, Measurement, PageCommand, WorkerRequest } from "./messages"
import { pick } from "./pick-mode"
import type { Picked } from "./pick-mode"
import { attempt } from "./prelude"
import { continuesFromAbove, conversationOf, focalPost } from "./x-markup"

/** How long the viewport must go without resizing before the Target is measured. */
const SETTLE_QUIET_MS = 300

/** The longest wait for the viewport to settle before measuring anyway. */
const SETTLE_LIMIT_MS = 2000

/** How long the Target must stay in place before it is measured. */
const STILL_MS = 300

/** The longest wait for the Target to stay in place before measuring anyway. */
const STILL_LIMIT_MS = 3000

/** The longest wait for a status page to render its Focal post before planning anyway. */
const FOCAL_POST_LIMIT_MS = 15_000

/** The longest wait for X to render the root Post at the top of a status page. */
const ROOT_POST_LIMIT_MS = 3000

/** The longest wait for the Target's images to load before measuring anyway. */
const IMAGES_LIMIT_MS = 5000

/** The longest wait for Truncated text to expand before capturing it as a Partial Capture. */
const EXPAND_LIMIT_MS = 5000

/** Whether Pick mode or its Capture is under way; a second Pick mode would put its highlight in the Capture. */
let pickInProgress = false

/** The element under the latest right-click, where a Post Capture from the menu starts. */
let rightClicked: Element | null = null

window.addEventListener(
  "contextmenu",
  (event) => {
    rightClicked = event.target instanceof Element ? event.target : null
  },
  { capture: true, passive: true }
)

chrome.runtime.onMessage.addListener(
  (
    command: PageCommand,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (measurement?: Measurement) => void
  ) => {
    switch (command.type) {
      case "enter-pick-mode":
        // The acknowledgement tells the worker this script is already loaded.
        sendResponse()
        void runPickMode()

        return false
      case "start-post-capture":
        sendResponse()
        void postCapture(command.destination)

        return false
      case "measure-post":
        void measurePostWhenRendered(command).then(sendResponse)

        return true
      case "measure":
        // Answered by the Pick Capture that asked for it.
        return false
    }
  }
)

async function runPickMode(): Promise<void> {
  if (pickInProgress) return
  pickInProgress = true

  try {
    await captureFromPickMode()
  } finally {
    pickInProgress = false
  }
}

async function captureFromPickMode(): Promise<void> {
  // Removed before the highlight appears, so no Confirmation is on the page during a Capture.
  dismissConfirmation()
  const picked = await pick()

  if (picked._tag === "cancelled") return

  await deliver({ destination: picked.destination, response: capturePicked(picked) })
}

/**
 * Start a Post Capture of the right-clicked Post. The worker captures it in a background tab,
 * so this page only delivers the image and shows the Confirmation.
 */
async function postCapture(destination: Destination): Promise<void> {
  dismissConfirmation()

  const started = rightClicked === null ? null : startPostCapture(rightClicked)

  // Injection after a menu click cannot recover the contextmenu event it missed.
  if (started === null)
    return showFailure("XShot is now loaded. Right-click the Post again to capture it.")

  if (started._tag === "err") return showRefusal(started.error)

  await deliver({
    destination,
    response: requestCapture({ type: "capture-post", start: started.value, destination }),
  })
}

/** Deliver a Capture the worker is taking to its Destination, then show the Confirmation. */
async function deliver(input: {
  readonly destination: Destination
  readonly response: Promise<CaptureResponse>
}): Promise<void> {
  switch (input.destination) {
    case "clipboard":
      return copyToClipboard(input.response)
    case "download":
      return confirmDownload(input.response)
  }
}

async function copyToClipboard(response: Promise<CaptureResponse>): Promise<void> {
  // The write starts right away, while the choosing click still counts as user activation and
  // the page has focus; the Clipboard takes the image once the worker has captured it.
  const png = response.then(pngOf)

  const written = await attempt(
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
  )

  // A refused or failed Capture also fails the write, so show its own reason first.
  const captured = captureOrShowFailure(await response)

  if (captured === null) return

  if (written._tag === "err") {
    return showFailure(`Couldn't copy to the Clipboard: ${written.error.message}`)
  }

  await showConfirmation(await png, "clipboard", captured.warnings)
}

async function confirmDownload(response: Promise<CaptureResponse>): Promise<void> {
  // The worker saves the Download before it answers.
  const captured = captureOrShowFailure(await response)

  if (captured === null) return

  await showConfirmation(pngFromBase64(captured.pngBase64), "download", captured.warnings)
}

/** Show a refused or failed Capture's Confirmation, or return the image that was captured. */
function captureOrShowFailure(
  response: CaptureResponse
): Extract<CaptureResponse, { readonly _tag: "captured" }> | null {
  switch (response._tag) {
    case "captured":
      return response
    case "refused":
      showRefusal(response.refusal)

      return null
    case "failed":
      showFailure(response.reason)

      return null
  }
}

/**
 * The captured image, for the Clipboard, which takes it as a promise and so learns of a
 * refused or failed Capture only through a rejection.
 */
function pngOf(response: CaptureResponse): Blob {
  if (response._tag !== "captured") throw new Error("Nothing was captured")

  return pngFromBase64(response.pngBase64)
}

/**
 * Ask the worker to capture the picked Target, measuring it when the worker is ready. The
 * page is put back as it was once the worker has captured it.
 */
async function capturePicked(picked: Picked): Promise<CaptureResponse> {
  let restore = (): void => {}

  function answerMeasure(
    command: PageCommand,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (measurement: Measurement) => void
  ): boolean {
    if (command.type !== "measure") return false

    void measureWhenSettled({
      start: { _tag: "pick", element: picked.target },
      destination: picked.destination,
    }).then((measured) => {
      restore = measured.restore
      sendResponse(measured.measurement)
    })

    return true
  }

  chrome.runtime.onMessage.addListener(answerMeasure)

  try {
    return await requestCapture({ type: "capture" })
  } finally {
    chrome.runtime.onMessage.removeListener(answerMeasure)
    restore()
  }
}

async function requestCapture(request: WorkerRequest): Promise<CaptureResponse> {
  const response = await attempt(
    chrome.runtime.sendMessage<WorkerRequest, CaptureResponse>(request)
  )

  if (response._tag === "err") {
    return { _tag: "failed", reason: `Couldn't reach XShot: ${response.error.message}` }
  }

  return response.value
}

/**
 * Measure a Post Capture on the Post's status page, once X has rendered the Focal post and the
 * images of its Conversation and the Truncated text is expanded. X renders the page after it
 * loads, so the Focal post can appear seconds later; the Posts above it arrive with it.
 */
async function measurePostWhenRendered(
  command: Extract<PageCommand, { readonly type: "measure-post" }>
): Promise<Measurement> {
  const input = command
  await observedUntil(() => focalPost(document) !== null, FOCAL_POST_LIMIT_MS)

  if (focalPost(document) !== null) {
    await scrollToRootPost()

    // Found again, because X renders other cells, and can render the Focal post anew, as the
    // page scrolls.
    const focal = focalPost(document)

    await expandTruncatedText(input)

    const expandedFocal = focalPost(document) ?? focal
    await Promise.all(
      (expandedFocal === null ? [] : conversationOf(expandedFocal)).map(imagesLoaded)
    )
  }

  // Planned again: Truncated text that didn't expand is still listed and makes a Partial Capture.
  // The page isn't put back: the worker closes this background tab after capturing.
  const { measurement } = await measureWhenSettled(input)

  return measurement
}

/**
 * Scroll to the top of the status page, where X renders the Conversation's earliest Posts, and
 * wait until its topmost Post is the root, or give up after a limit. X's list keeps only the
 * Posts near the viewport, so in a long Conversation the Posts above the Focal post can be
 * missing until the page scrolls up to them.
 */
async function scrollToRootPost(): Promise<void> {
  const { scrollX, scrollY } = window
  window.scrollTo(0, 0)

  await observedUntil(() => {
    const focal = focalPost(document)

    return focal === null || !continuesFromAbove(conversationOf(focal)[0])
  }, ROOT_POST_LIMIT_MS)

  if (focalPost(document) !== null) return

  // The Conversation is taller than X keeps rendered, so the Focal post went away. Go back to
  // it: the Capture is then a Partial Capture that doesn't start at the root Post.
  window.scrollTo(scrollX, scrollY)
  await observedUntil(() => focalPost(document) !== null, FOCAL_POST_LIMIT_MS)
}

/**
 * Click the "Show more" controls the plan lists. X expands the text in place and removes the
 * control, so this waits until every control is gone, or gives up after a limit.
 */
async function expandTruncatedText(input: CaptureRequest): Promise<void> {
  // Only what to expand is needed, so nothing is measured yet.
  const planned = planOnPage(input, UNMEASURED)

  if (planned._tag === "err") return

  const controls = planned.value.expand

  for (const control of controls) {
    if (control instanceof HTMLElement) control.click()
  }

  await observedUntil(() => controls.every((control) => !control.isConnected), EXPAND_LIMIT_MS)
}

/** A measurement, and how to put back what was changed on the page for it. */
type Measured = { readonly measurement: Measurement; readonly restore: () => void }

/** A layout in which nothing is measured yet, for planning only what a Capture shows. */
const UNMEASURED: Layout = {
  boundsOf: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  scroll: { x: 0, y: 0 },
  imageLoaded,
}

/**
 * Plan the Capture once the viewport has settled, without the scrollbar, with its Clutter out
 * of the layout and with nothing floating over it. All of that lasts until `restore` is
 * called, so the screenshot shows the page as it was measured.
 */
async function measureWhenSettled(input: CaptureRequest): Promise<Measured> {
  // The screenshot makes the viewport as tall as the page, which drops the scrollbar and
  // widens the layout, so a centred page such as X's moves sideways off the crop. Without the
  // scrollbar the page is measured as the screenshot shows it. Hiding it resizes the viewport,
  // which the wait for the viewport to settle covers.
  const restoreScrollbar = overrideStyle([document.documentElement], "scrollbar-width", "none")
  await viewportSettled()

  // The Clutter changes the Target's size, so it is planned once unmeasured to learn the
  // Clutter, and measured only once the Clutter is out of the layout.
  const unmeasured = planOnPage(input, UNMEASURED)

  const restoreClutter = overrideStyle(
    unmeasured._tag === "ok" ? unmeasured.value.clutter : [],
    "display",
    "none"
  )

  const planned = await plannedWhenStill(input)

  if (planned._tag === "err") {
    restoreClutter()
    restoreScrollbar()

    return { measurement: { _tag: "refused", refusal: planned.error }, restore: () => {} }
  }

  const { crop, destination, target, warnings } = planned.value

  // Hidden rather than taken out of the layout, so nothing moves after measuring.
  const restoreFloating = overrideStyle(floatingOver(crop, target), "visibility", "hidden")

  return {
    measurement: {
      _tag: "measured",
      crop,
      devicePixelRatio: window.devicePixelRatio,
      destination,
      warnings,
    },
    restore: () => {
      restoreFloating()
      restoreClutter()
      restoreScrollbar()
    },
  }
}

/**
 * Plan the Capture as the page is laid out now, once the Target has stayed in place for a
 * moment, or after a limit. X lays out its lists after the fact: when text above the Focal
 * post expands, or the Clutter leaves the layout, it moves the Posts and the scroll position
 * to keep the Focal post in view, and until then a Conversation can even start above the top
 * of the page.
 */
async function plannedWhenStill(input: CaptureRequest): Promise<ReturnType<typeof planOnPage>> {
  const deadline = performance.now() + STILL_LIMIT_MS
  let planned = planMeasured(input)

  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STILL_MS))
    const again = planMeasured(input)

    if (sameCrop(planned, again)) return again

    planned = again
  }

  return planned
}

function planMeasured(input: CaptureRequest): ReturnType<typeof planOnPage> {
  return planOnPage(input, {
    boundsOf: (element) => element.getBoundingClientRect(),
    scroll: { x: window.scrollX, y: window.scrollY },
    imageLoaded,
  })
}

/** Whether two plans crop the same part of the page, or are refused for the same reason. */
function sameCrop(a: ReturnType<typeof planOnPage>, b: ReturnType<typeof planOnPage>): boolean {
  if (a._tag === "err" || b._tag === "err") {
    return a._tag === "err" && b._tag === "err" && a.error._tag === b.error._tag
  }

  const [one, other] = [a.value.crop, b.value.crop]

  return (
    one.x === other.x &&
    one.y === other.y &&
    one.width === other.width &&
    one.height === other.height
  )
}

/**
 * The page's fixed and sticky elements over the crop, such as X's header over a Post scrolled
 * up under it. The screenshot draws them where they are on screen, on top of whatever the crop
 * shows there. Elements holding the Target, such as a dialog it is in, and elements inside it
 * are part of what is captured.
 */
function floatingOver(crop: Rect, target: Target): Element[] {
  return [...document.body.querySelectorAll("*")].filter((element) => {
    const { position } = getComputedStyle(element)

    if (position !== "fixed" && position !== "sticky") return false

    if (target.some((item) => element.contains(item) || item.contains(element))) return false

    const bounds = element.getBoundingClientRect()
    const left = bounds.left + window.scrollX
    const top = bounds.top + window.scrollY

    return (
      bounds.width > 0 &&
      bounds.height > 0 &&
      left < crop.x + crop.width &&
      left + bounds.width > crop.x &&
      top < crop.y + crop.height &&
      top + bounds.height > crop.y
    )
  })
}

/**
 * Override a style property of elements, without detaching them from the page, which X's own
 * scripts still manage.
 *
 * @returns How to put the property back as it was.
 */
function overrideStyle(
  elements: ReadonlyArray<Element>,
  property: string,
  value: string
): () => void {
  // Read before any is changed, so an element listed twice still gets its own value back.
  const changed = elements.flatMap((element) =>
    element instanceof HTMLElement
      ? [
          {
            element,
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
          },
        ]
      : []
  )

  for (const { element } of changed) element.style.setProperty(property, value, "important")

  return () => {
    for (const { element, value: was, priority } of changed) {
      if (was === "") element.style.removeProperty(property)
      else element.style.setProperty(property, was, priority)
    }
  }
}

/**
 * Plan a Capture of this page in the given layout, including its current image load state.
 */
function planOnPage(input: CaptureRequest, layout: Layout): ReturnType<typeof planCapture> {
  return planCapture({
    page: document,
    start: input.start,
    destination: input.destination,
    url: new URL(window.location.href),
    now: new Date(),
    layout,
  })
}

/**
 * Resolve once `done` holds after a change to the page, or after a limit. Watches the DOM
 * rather than polling on a timer, because timers in a background tab are throttled.
 */
function observedUntil(done: () => boolean, limitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(check)
    const limit = setTimeout(settle, limitMs)

    function check(): void {
      if (done()) settle()
    }

    function settle(): void {
      clearTimeout(limit)
      observer.disconnect()
      resolve()
    }

    observer.observe(document, { childList: true, subtree: true })
    check()
  })
}

/** Whether the browser loaded an image successfully, including already-complete failures. */
function imageLoaded(image: Element): boolean {
  return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
}

/** Resolve once every image in an element has loaded or failed, or after a limit. */
async function imagesLoaded(element: Element): Promise<void> {
  const pending = [...element.querySelectorAll("img")].filter((image) => !image.complete)

  const loads = pending.map(
    (image) =>
      new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true })
        image.addEventListener("error", () => resolve(), { once: true })
      })
  )

  await Promise.race([
    Promise.all(loads),
    new Promise<void>((resolve) => setTimeout(resolve, IMAGES_LIMIT_MS)),
  ])
}

/** Resolve once the viewport has gone a moment without resizing, or after a limit. */
function viewportSettled(): Promise<void> {
  return new Promise((resolve) => {
    let quiet = setTimeout(settle, SETTLE_QUIET_MS)
    const limit = setTimeout(settle, SETTLE_LIMIT_MS)

    function restart(): void {
      clearTimeout(quiet)
      quiet = setTimeout(settle, SETTLE_QUIET_MS)
    }

    function settle(): void {
      clearTimeout(quiet)
      clearTimeout(limit)
      window.removeEventListener("resize", restart)
      resolve()
    }

    window.addEventListener("resize", restart)
  })
}

function pngFromBase64(base64: string): Blob {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))

  return new Blob([bytes], { type: "image/png" })
}
