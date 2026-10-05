import { planCapture } from "./capture-plan"
import { dismissConfirmation, showConfirmation, showFailure, showRefusal } from "./confirmation"
import type { CaptureResponse, Measurement, PageCommand, WorkerRequest } from "./messages"
import { pick } from "./pick-mode"
import type { Picked } from "./pick-mode"
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

  switch (picked.destination) {
    case "clipboard":
      return copyToClipboard(picked)
    case "download":
      return saveDownload(picked)
  }
}

async function copyToClipboard(picked: Picked): Promise<void> {
  // The write starts right away, while the choosing click still counts as user activation and
  // the page has focus; the Clipboard takes the image once the worker has captured it.
  const response = capture(picked)
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

async function saveDownload(picked: Picked): Promise<void> {
  // The worker saves the Download before it answers.
  const captured = await capture(picked)

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

/** Ask the worker to capture the Target, measuring it when the worker is ready. */
async function capture(picked: Picked): Promise<CaptureResponse> {
  function answerMeasure(
    command: PageCommand,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (measurement: Measurement) => void
  ): boolean {
    if (command.type !== "measure") return false

    void measureWhenSettled(picked).then(sendResponse)

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

async function measureWhenSettled(picked: Picked): Promise<Measurement> {
  await viewportSettled()

  const planned = planCapture({
    start: { _tag: "pick", element: picked.target },
    destination: picked.destination,
    url: new URL(window.location.href),
    now: new Date(),
    layout: {
      boundsOf: (element) => element.getBoundingClientRect(),
      scroll: { x: window.scrollX, y: window.scrollY },
    },
  })

  if (planned._tag === "err") return { _tag: "refused", refusal: planned.error }

  const { crop, destination } = planned.value

  return { _tag: "measured", crop, devicePixelRatio: window.devicePixelRatio, destination }
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
