import type { CaptureResponse, Measurement, PageCommand, WorkerRequest } from "./messages"
import { attempt, err, ok } from "./prelude"
import type { Result } from "./prelude"

/** Every Capture has two image pixels per CSS pixel, whatever the screen's pixel ratio. */
const CAPTURE_SCALE = 2

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return
  void enterPickMode(tab.id)
})

chrome.runtime.onMessage.addListener(
  (
    _request: WorkerRequest,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: CaptureResponse) => void
  ) => {
    const tabId = sender.tab?.id

    if (tabId === undefined) return false

    void capture(tabId).then(sendResponse)

    return true
  }
)

async function enterPickMode(tabId: number): Promise<void> {
  // The page script stays loaded until the page navigates and acknowledges the command, so
  // it is injected only when nothing answers.
  const delivered = await attempt(
    chrome.tabs.sendMessage<PageCommand>(tabId, { type: "enter-pick-mode" })
  )

  if (delivered._tag === "ok") return

  const injected = await attempt(
    chrome.scripting.executeScript({ target: { tabId }, files: ["page.js"] })
  )

  if (injected._tag === "err") {
    console.warn(`XShot can't run on this page: ${injected.error.message}`)

    return
  }

  await attempt(chrome.tabs.sendMessage<PageCommand>(tabId, { type: "enter-pick-mode" }))
}

async function capture(tabId: number): Promise<CaptureResponse> {
  const debuggee = { tabId }
  const attached = await attempt(chrome.debugger.attach(debuggee, "1.3"))

  if (attached._tag === "err") return failed("attach the debugger", attached.error)

  try {
    return await screenshot(debuggee, tabId)
  } finally {
    // Fails harmlessly when the user already detached from the "started debugging" banner.
    await attempt(chrome.debugger.detach(debuggee))
  }
}

async function screenshot(
  debuggee: chrome.debugger.Debuggee,
  tabId: number
): Promise<CaptureResponse> {
  // Attaching shows the "started debugging this browser" banner, which shrinks the viewport.
  // The page measures only once that resize is over: capturing while the page is still
  // resizing produces repeated tiles instead of the Target.
  const measured = await attempt(
    chrome.tabs.sendMessage<PageCommand, Measurement>(tabId, { type: "measure" })
  )

  if (measured._tag === "err") return failed("measure the Target", measured.error)

  const { crop, devicePixelRatio, destination } = measured.value

  const shot = await attempt(
    chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      // Chromium multiplies the clip by the screen's pixel ratio as well as by `scale`.
      clip: { ...crop, scale: CAPTURE_SCALE / devicePixelRatio },
    })
  )

  if (shot._tag === "err") return failed("take the screenshot", shot.error)

  // SAFETY: The protocol defines Page.captureScreenshot's result as `{ data: string }`, the
  // base64-encoded image, and the command resolved without an error.
  const { data } = shot.value as { readonly data: string }

  switch (destination._tag) {
    case "clipboard":
      // The page writes the Clipboard, which a service worker can't reach.
      return { _tag: "captured", pngBase64: data }
    case "download": {
      const saved = await saveDownload({ pngBase64: data, filename: destination.filename })

      if (saved._tag === "err") return failed("save the Download", saved.error)

      return { _tag: "captured", pngBase64: data }
    }
  }
}

/**
 * Save a PNG to the downloads folder without a Save As dialog, resolving once the file is
 * written or the download has failed.
 *
 * A data: URL, because a service worker can't create blob: URLs; Chromium downloads data:
 * URLs far larger than the 2 MB it allows elsewhere.
 */
async function saveDownload(input: {
  readonly pngBase64: string
  readonly filename: string
}): Promise<Result<void, Error>> {
  const started = await attempt(
    chrome.downloads.download({
      url: `data:image/png;base64,${input.pngBase64}`,
      filename: input.filename,
      saveAs: false,
      conflictAction: "uniquify",
    })
  )

  if (started._tag === "err") return started

  return downloadFinished(started.value)
}

/** Resolve once a download has completed or been interrupted. */
function downloadFinished(downloadId: number): Promise<Result<void, Error>> {
  return new Promise((resolve) => {
    function settle(state: string, error: string | undefined): void {
      if (state === "in_progress") return
      chrome.downloads.onChanged.removeListener(follow)
      resolve(state === "complete" ? ok(undefined) : err(new Error(error ?? "it was interrupted")))
    }

    function follow(delta: chrome.downloads.DownloadDelta): void {
      const state = delta.state?.current

      if (delta.id !== downloadId || state === undefined) return
      settle(state, delta.error?.current)
    }

    chrome.downloads.onChanged.addListener(follow)

    // The download can finish before the listener is added. Settling twice is harmless.
    void attempt(chrome.downloads.search({ id: downloadId })).then((found) => {
      if (found._tag === "ok" && found.value[0] !== undefined) {
        settle(found.value[0].state, found.value[0].error)
      }
    })
  })
}

function failed(step: string, error: Error): CaptureResponse {
  return { _tag: "failed", reason: `Couldn't ${step}: ${error.message}` }
}
