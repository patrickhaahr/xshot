import { planCapture } from "./capture-plan"
import { dismissConfirmation, showConfirmation, showFailure } from "./confirmation"
import type { CaptureResponse, Measurement, PageCommand, WorkerRequest } from "./messages"
import { pick } from "./pick-mode"
import type { Picked } from "./pick-mode"
import { attempt } from "./prelude"

/** How long the viewport must go without resizing before the Target is measured. */
const SETTLE_QUIET_MS = 300

/** The longest wait for the viewport to settle before measuring anyway. */
const SETTLE_LIMIT_MS = 2000

let picking = false

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
  if (picking) return
  picking = true
  dismissConfirmation()
  const picked = await pick()
  picking = false

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
  const png = capture(picked)

  const written = await attempt(
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
  )

  const captured = await attempt(png)

  // A failed Capture also fails the write, so its own reason is the one worth showing.
  if (captured._tag === "err") return showFailure(captured.error.message)

  if (written._tag === "err") {
    return showFailure(`Couldn't copy to the Clipboard: ${written.error.message}`)
  }

  await showConfirmation(captured.value, "Copied to Clipboard")
}

async function saveDownload(picked: Picked): Promise<void> {
  // The worker saves the Download before it answers.
  const captured = await attempt(capture(picked))

  if (captured._tag === "err") return showFailure(captured.error.message)

  await showConfirmation(captured.value, "Saved to Downloads")
}

/**
 * Ask the worker to capture the Target, measuring it when the worker is ready.
 *
 * Rejects on failure rather than returning a result, because the Clipboard takes the image
 * as a promise.
 */
async function capture(picked: Picked): Promise<Blob> {
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

async function measureWhenSettled(picked: Picked): Promise<Measurement> {
  await viewportSettled()

  const { crop, destination } = planCapture({
    start: { _tag: "pick", element: picked.element },
    destination: picked.destination,
    url: new URL(window.location.href),
    now: new Date(),
    layout: {
      boundsOf: (element) => element.getBoundingClientRect(),
      scroll: { x: window.scrollX, y: window.scrollY },
    },
  })

  return { crop, devicePixelRatio: window.devicePixelRatio, destination }
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
