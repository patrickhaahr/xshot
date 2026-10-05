import { planCapture } from "./capture-plan"
import { dismissConfirmation, showConfirmation } from "./confirmation"
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
  const png = capture(picked.target)

  const written = await attempt(
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
  )

  if (written._tag === "err") {
    console.error(`XShot: ${written.error.message}`)

    return
  }

  await showConfirmation(await png, "Copied to Clipboard")
}

/**
 * Ask the worker to capture the Target, measuring it when the worker is ready.
 *
 * Rejects on failure rather than returning a result, because the Clipboard takes the image
 * as a promise.
 */
async function capture(target: Element): Promise<Blob> {
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

  try {
    const response = await chrome.runtime.sendMessage<WorkerRequest, CaptureResponse>({
      type: "capture",
    })

    switch (response._tag) {
      case "captured":
        return pngFromBase64(response.pngBase64)
      case "failed":
        throw new Error(response.reason)
    }
  } finally {
    chrome.runtime.onMessage.removeListener(answerMeasure)
  }
}

async function measureWhenSettled(target: Element): Promise<Measurement> {
  await viewportSettled()

  const { crop } = planCapture({
    start: { _tag: "pick", element: target },
    layout: {
      boundsOf: (element) => element.getBoundingClientRect(),
      scroll: { x: window.scrollX, y: window.scrollY },
    },
  })

  return { crop, devicePixelRatio: window.devicePixelRatio }
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
