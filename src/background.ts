import type { CaptureResponse, Measurement, PageCommand, WorkerRequest } from "./messages"
import { attempt } from "./prelude"

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

  const { crop, devicePixelRatio } = measured.value

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

  return { _tag: "captured", pngBase64: data }
}

function failed(step: string, error: Error): CaptureResponse {
  return { _tag: "failed", reason: `Couldn't ${step}: ${error.message}` }
}
