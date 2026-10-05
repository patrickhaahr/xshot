import { planCapture, startPostCapture } from "./capture-plan"
import type { CaptureStart, Destination, Layout } from "./capture-plan"
import { dismissConfirmation, showConfirmation, showFailure, showRefusal } from "./confirmation"
import type { CaptureResponse, Measurement, PageCommand, WorkerRequest } from "./messages"
import { pick } from "./pick-mode"
import type { Picked } from "./pick-mode"
import { attempt } from "./prelude"
import { focalPost } from "./x-markup"

/** How long the viewport must go without resizing before the Target is measured. */
const SETTLE_QUIET_MS = 300

/** The longest wait for the viewport to settle before measuring anyway. */
const SETTLE_LIMIT_MS = 2000

/** The longest wait for a status page to render its Focal post before planning anyway. */
const FOCAL_POST_LIMIT_MS = 15_000

/** The longest wait for the Target's images to load before measuring anyway. */
const IMAGES_LIMIT_MS = 5000

/** Whether Pick mode or its Capture is under way; a second Pick mode would put its highlight in the Capture. */
let busy = false

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
        void pickAndCapture()

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

async function pickAndCapture(): Promise<void> {
  if (busy) return
  busy = true

  try {
    await pickThenCapture()
  } finally {
    busy = false
  }
}

async function pickThenCapture(): Promise<void> {
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

  if (started === null) return showRefusal({ _tag: "no-post" })

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

  const captured = await response

  // A refused or failed Capture also fails the write, so its own reason is the one worth showing.
  switch (captured._tag) {
    case "refused":
      return showRefusal(captured.refusal)
    case "failed":
      return showFailure(captured.reason)
    case "captured":
      break
  }

  if (written._tag === "err") {
    return showFailure(`Couldn't copy to the Clipboard: ${written.error.message}`)
  }

  await showConfirmation(await png, "Copied to Clipboard")
}

async function confirmDownload(response: Promise<CaptureResponse>): Promise<void> {
  // The worker saves the Download before it answers.
  const captured = await response

  switch (captured._tag) {
    case "refused":
      return showRefusal(captured.refusal)
    case "failed":
      return showFailure(captured.reason)
    case "captured":
      return showConfirmation(pngFromBase64(captured.pngBase64), "Saved to Downloads")
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
 * page gets its Clutter back once the worker has captured it.
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
 * Measure a Post Capture on the Post's status page, once X has rendered the Focal post and its
 * images. X renders the page after it loads, so the Focal post can appear seconds later.
 */
async function measurePostWhenRendered(
  command: Extract<PageCommand, { readonly type: "measure-post" }>
): Promise<Measurement> {
  const focal = await rendered(() => focalPost(document), FOCAL_POST_LIMIT_MS)

  if (focal !== null) await imagesLoaded(focal)

  // The Clutter stays out of the layout: the worker closes this background tab after capturing.
  const { measurement } = await measureWhenSettled({
    start: command.start,
    destination: command.destination,
  })

  return measurement
}

/** A measurement, and how to put back the Clutter taken out of the layout for it. */
type Measured = { readonly measurement: Measurement; readonly restore: () => void }

/** A layout in which nothing is measured yet, for planning only what a Capture shows. */
const UNMEASURED: Layout = {
  boundsOf: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  scroll: { x: 0, y: 0 },
}

/**
 * Plan the Capture once the viewport has settled, with its Clutter out of the layout. The
 * Clutter stays out until `restore` is called, so the screenshot doesn't show it either.
 */
async function measureWhenSettled(input: {
  readonly start: CaptureStart
  readonly destination: Destination
}): Promise<Measured> {
  await viewportSettled()

  function plan(layout: Layout): ReturnType<typeof planCapture> {
    return planCapture({
      page: document,
      start: input.start,
      destination: input.destination,
      url: new URL(window.location.href),
      now: new Date(),
      layout,
    })
  }

  // The Clutter changes the Target's size, so it is planned once unmeasured to learn the
  // Clutter, and measured only once the Clutter is out of the layout.
  const unmeasured = plan(UNMEASURED)
  const restore = removeFromLayout(unmeasured._tag === "ok" ? unmeasured.value.clutter : [])

  const planned = plan({
    boundsOf: (element) => element.getBoundingClientRect(),
    scroll: { x: window.scrollX, y: window.scrollY },
  })

  if (planned._tag === "err") {
    restore()

    return { measurement: { _tag: "refused", refusal: planned.error }, restore: () => {} }
  }

  const { crop, destination } = planned.value

  return {
    measurement: { _tag: "measured", crop, devicePixelRatio: window.devicePixelRatio, destination },
    restore,
  }
}

/**
 * Take elements out of the layout, so they leave no gap, without detaching them from the page,
 * which X's own scripts still manage.
 *
 * @returns How to put them back as they were.
 */
function removeFromLayout(elements: ReadonlyArray<Element>): () => void {
  // Read before any is removed, so an element listed twice still gets its own value back.
  const removed = elements.flatMap((element) =>
    element instanceof HTMLElement
      ? [
          {
            element,
            display: element.style.getPropertyValue("display"),
            priority: element.style.getPropertyPriority("display"),
          },
        ]
      : []
  )

  for (const { element } of removed) element.style.setProperty("display", "none", "important")

  return () => {
    for (const { element, display, priority } of removed) {
      if (display === "") element.style.removeProperty("display")
      else element.style.setProperty("display", display, priority)
    }
  }
}

/**
 * Resolve with the element `find` returns once the page has rendered it, or with null after a
 * limit. Watches the DOM rather than polling on a timer, because timers in a background tab
 * are throttled.
 */
function rendered(find: () => Element | null, limitMs: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(check)

    const limit = setTimeout(() => {
      settle(null)
    }, limitMs)

    function check(): void {
      const found = find()

      if (found !== null) settle(found)
    }

    function settle(found: Element | null): void {
      clearTimeout(limit)
      observer.disconnect()
      resolve(found)
    }

    observer.observe(document, { childList: true, subtree: true })
    check()
  })
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
