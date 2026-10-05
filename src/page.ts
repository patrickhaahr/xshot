import { planCapture } from "./capture-plan"
import { dismissConfirmation, showConfirmation, showRefusal } from "./confirmation"
import type { CaptureResponse, Measurement, PageCommand, WorkerRequest } from "./messages"
import { pick } from "./pick-mode"
import { attempt } from "./prelude"

/** How long the viewport must go without resizing before the Target is measured. */
const SETTLE_QUIET_MS = 300

/** The longest wait for the viewport to settle before measuring anyway. */
const SETTLE_LIMIT_MS = 2000

/** Whether Pick mode or its Capture is under way; a second Pick mode would put its highlight in the Capture. */
let busy = false

chrome.runtime.onMessage.addListener(
  (command: PageCommand, _sender: chrome.runtime.MessageSender, sendResponse: () => void) => {
    if (command.type !== "enter-pick-mode") return false

    // The acknowledgement tells the worker this script is already loaded.
    sendResponse()
    void pickAndCapture()

    return false
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

  // The write starts right away, while the choosing click still counts as user activation and
  // the page has focus; the Clipboard takes the image once the worker has captured it.
  const response = capture(picked.target)
  const png = response.then(pngOf)

  const written = await attempt(
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
  )

  const captured = await response

  switch (captured._tag) {
    case "refused":
      showRefusal(captured.refusal)

      return
    case "failed":
      console.error(`XShot: ${captured.reason}`)

      return
    case "captured":
      break
  }

  if (written._tag === "err") {
    console.error(`XShot: ${written.error.message}`)

    return
  }

  await showConfirmation(await png, "Copied to Clipboard")
}

/**
 * The captured image, for the Clipboard, which takes it as a promise and so learns of a
 * refused or failed Capture only through a rejection.
 */
function pngOf(response: CaptureResponse): Blob {
  if (response._tag !== "captured") throw new Error("Nothing was captured")

  return pngFromBase64(response.pngBase64)
}

/** Ask the worker to capture the Target, measuring it when the worker is ready. */
async function capture(target: Element): Promise<CaptureResponse> {
  function answerMeasure(
    command: PageCommand,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (measurement: Measurement) => void
  ): boolean {
    if (command.type !== "measure") return false

    void measureWhenSettled(target).then(sendResponse)

    return true
  }

  chrome.runtime.onMessage.addListener(answerMeasure)

  const response = await attempt(
    chrome.runtime.sendMessage<WorkerRequest, CaptureResponse>({ type: "capture" })
  )

  chrome.runtime.onMessage.removeListener(answerMeasure)

  if (response._tag === "err") {
    return { _tag: "failed", reason: `Couldn't reach XShot: ${response.error.message}` }
  }

  return response.value
}

async function measureWhenSettled(target: Element): Promise<Measurement> {
  await viewportSettled()

  const planned = planCapture({
    start: { _tag: "pick", element: target },
    layout: {
      boundsOf: (element) => element.getBoundingClientRect(),
      scroll: { x: window.scrollX, y: window.scrollY },
    },
  })

  if (planned._tag === "err") return { _tag: "refused", refusal: planned.error }

  return { _tag: "measured", crop: planned.value.crop, devicePixelRatio: window.devicePixelRatio }
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
