import { planCapture, startPostCapture } from "./capture-plan"
import type { CaptureStart, Destination } from "./capture-plan"
import { dismissConfirmation, showConfirmation, showFailure, showRefusal } from "./confirmation"
import type { CaptureResponse, Measurement, PageCommand, WorkerRequest } from "./messages"
import { pick } from "./pick-mode"
import type { Picked } from "./pick-mode"
import { attempt } from "./prelude"
import { conversationOf, focalPost } from "./x-markup"

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

  await showConfirmation(await png, "Copied to Clipboard", captured.warnings)
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
      return showConfirmation(
        pngFromBase64(captured.pngBase64),
        "Saved to Downloads",
        captured.warnings
      )
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

/** Ask the worker to capture the picked Target, measuring it when the worker is ready. */
async function capturePicked(picked: Picked): Promise<CaptureResponse> {
  function answerMeasure(
    command: PageCommand,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (measurement: Measurement) => void
  ): boolean {
    if (command.type !== "measure") return false

    void measureWhenSettled({
      start: { _tag: "pick", element: picked.target },
      destination: picked.destination,
    }).then(sendResponse)

    return true
  }

  chrome.runtime.onMessage.addListener(answerMeasure)
  const response = await requestCapture({ type: "capture" })
  chrome.runtime.onMessage.removeListener(answerMeasure)

  return response
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
 * images of its Conversation. X renders the page after it loads, so the Focal post can appear
 * seconds later; the Posts above it arrive with it.
 */
async function measurePostWhenRendered(
  command: Extract<PageCommand, { readonly type: "measure-post" }>
): Promise<Measurement> {
  const focal = await rendered(() => focalPost(document), FOCAL_POST_LIMIT_MS)

  if (focal !== null) await Promise.all(conversationOf(focal).map(imagesLoaded))

  return measureWhenSettled({ start: command.start, destination: command.destination })
}

async function measureWhenSettled(input: {
  readonly start: CaptureStart
  readonly destination: Destination
}): Promise<Measurement> {
  await viewportSettled()

  const planned = planCapture({
    page: document,
    start: input.start,
    destination: input.destination,
    url: new URL(window.location.href),
    now: new Date(),
    layout: {
      boundsOf: (element) => element.getBoundingClientRect(),
      scroll: { x: window.scrollX, y: window.scrollY },
    },
  })

  if (planned._tag === "err") return { _tag: "refused", refusal: planned.error }

  const { crop, destination, warnings } = planned.value

  return {
    _tag: "measured",
    crop,
    devicePixelRatio: window.devicePixelRatio,
    destination,
    warnings,
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
