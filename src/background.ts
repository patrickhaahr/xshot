import { CAPTURE_SCALE } from "./capture-plan"
import type { Destination } from "./capture-plan"
import type { CaptureResponse, Measurement, PageCommand, WorkerRequest } from "./messages"
import { attempt, err, ok } from "./prelude"
import type { Result } from "./prelude"
import { X_PAGES, statusPageUrl } from "./x-markup"

/** The right-click menu items that start a Post Capture, each to its own Destination. */
const POST_MENU_ITEMS: ReadonlyArray<{
  readonly id: string
  readonly title: string
  readonly destination: Destination
}> = [
  { id: "screenshot-post", title: "Screenshot post", destination: "clipboard" },
  { id: "screenshot-post-to-file", title: "Screenshot post to file", destination: "download" },
]

/** The longest wait for a debugger rendering or screenshot command before refusing to hang. */
const CAPTURE_LIMIT_MS = 15_000

/** The longest wait for a Post's status page to start loading in its background tab. */
const STATUS_PAGE_LOAD_LIMIT_MS = 30_000

/** A screenshot this fast, in milliseconds, means a background tab is drawing. */
const RENDERING_QUICK_MS = 50

/** How many fast screenshots in a row show that a background tab keeps drawing. */
const RENDERING_QUICK_SHOTS = 3

/** How often to check whether the page script has started in a Post's background tab. */
const PAGE_SCRIPT_POLL_MS = 50

chrome.runtime.onInstalled.addListener(() => {
  for (const { id, title } of POST_MENU_ITEMS) {
    chrome.contextMenus.create({
      id,
      title,
      // Everything a Post can contain; "all" would also add it to the toolbar button's menu.
      contexts: ["page", "selection", "link", "image", "video", "editable"],
      documentUrlPatterns: X_PAGES,
    })
  }
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const item = POST_MENU_ITEMS.find(({ id }) => id === info.menuItemId)

  if (item === undefined || tab?.id === undefined) return
  void onScreenshotPostMenu({
    tabId: tab.id,
    frameId: info.frameId ?? 0,
    destination: item.destination,
  })
})

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return
  void enterPickMode(tab.id)
})

chrome.runtime.onMessage.addListener(
  (
    request: WorkerRequest,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: CaptureResponse) => void
  ) => {
    const tab = sender.tab

    if (tab?.id === undefined) return false

    switch (request.type) {
      case "capture":
        void capture(tab.id, { type: "measure" }).then(sendResponse)
        break
      case "capture-post":
        void captureFromStatusPage(request, tab).then(sendResponse)
        break
    }

    return true
  }
)

/** Tell the right-clicked page to start a Post Capture from the element under the right-click. */
async function onScreenshotPostMenu(input: {
  readonly tabId: number
  readonly frameId: number
  readonly destination: Destination
}): Promise<void> {
  const delivered = await sendPageCommand({
    tabId: input.tabId,
    frameId: input.frameId,
    command: { type: "start-post-capture", destination: input.destination },
  })

  if (delivered._tag === "err") await showUnavailablePage(input.tabId, delivered.error)
}

/**
 * Capture a Post from its own status page, opened in a background tab next to the page it was
 * right-clicked on and closed afterwards, so the user stays where they are. The page asks for
 * this only when it doesn't show the Post's whole Conversation itself.
 */
async function captureFromStatusPage(
  request: Extract<WorkerRequest, { readonly type: "capture-post" }>,
  opener: chrome.tabs.Tab
): Promise<CaptureResponse> {
  const created = await attempt(
    chrome.tabs.create({
      url: statusPageUrl(request.start.post),
      active: false,
      index: opener.index + 1,
      windowId: opener.windowId,
      openerTabId: opener.id,
    })
  )

  if (created._tag === "err") return failed("open the Post's status page", created.error)

  const tabId = created.value.id

  if (tabId === undefined) return { _tag: "failed", reason: "Couldn't open the Post's status page" }

  try {
    // Captured as soon as the tab exists: the page script starts with the page and waits for X
    // to render the Post itself, so X's load event, seconds later, doesn't matter.
    return await capture(tabId, {
      type: "measure-post",
      start: request.start,
      destination: request.destination,
    })
  } finally {
    await attempt(chrome.tabs.remove(tabId))
  }
}

/**
 * Resolve once the page script runs in a tab XShot just opened, or with an error if the tab
 * closes or takes too long. It runs from the start of the page's load.
 */
async function pageScriptRunning(tabId: number): Promise<Result<void, Error>> {
  const deadline = Date.now() + STATUS_PAGE_LOAD_LIMIT_MS

  while (Date.now() < deadline) {
    const answered = await attempt(
      chrome.tabs.sendMessage<PageCommand, void>(tabId, { type: "ping" })
    )

    if (answered._tag === "ok") return answered

    const found = await attempt(chrome.tabs.get(tabId))

    if (found._tag === "err") return err(new Error("its tab was closed"))

    await new Promise((resolve) => setTimeout(resolve, PAGE_SCRIPT_POLL_MS))
  }

  return err(new Error("it took too long"))
}

async function enterPickMode(tabId: number): Promise<void> {
  const delivered = await sendPageCommand({ tabId, command: { type: "enter-pick-mode" } })

  if (delivered._tag === "err") await showUnavailablePage(tabId, delivered.error)
}

/** Inject the page script and retry when a tab predates installation or an extension reload. */
async function sendPageCommand(input: {
  readonly tabId: number
  readonly frameId?: number
  readonly command: PageCommand
}): Promise<Result<void, Error>> {
  const { tabId, frameId = 0, command } = input
  await attempt(chrome.action.setBadgeText({ tabId, text: "" }))
  await attempt(chrome.action.setTitle({ tabId, title: "XShot" }))

  const delivered = await attempt(
    chrome.tabs.sendMessage<PageCommand, void>(tabId, command, { frameId })
  )

  if (delivered._tag === "ok") return delivered

  const injected = await attempt(
    chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["page.js"] })
  )

  if (injected._tag === "err") return injected

  return attempt(chrome.tabs.sendMessage<PageCommand, void>(tabId, command, { frameId }))
}

/** A visible fallback when scripting is unavailable and an on-page Confirmation is impossible. */
async function showUnavailablePage(tabId: number, error: Error): Promise<void> {
  await attempt(chrome.action.setBadgeText({ tabId, text: "!" }))
  await attempt(chrome.action.setTitle({ tabId, title: `XShot couldn't run: ${error.message}` }))
}

/**
 * Screenshot a tab's Target, which the page measures when it receives `measure`.
 *
 * @param tabId - The tab to capture.
 * @param measure - The command that makes the page measure its Target.
 */
async function capture(
  tabId: number,
  measure: Extract<PageCommand, { readonly type: "measure" | "measure-post" }>
): Promise<CaptureResponse> {
  const debuggee = { tabId }
  const attached = await attempt(chrome.debugger.attach(debuggee, "1.3"))

  if (attached._tag === "err") return failed("attach the debugger", attached.error)

  try {
    return await screenshot({ debuggee, tabId, measure })
  } finally {
    // Fails harmlessly when the user already detached from the "started debugging" banner.
    await attempt(chrome.debugger.detach(debuggee))
  }
}

async function screenshot(input: {
  readonly debuggee: chrome.debugger.Debuggee
  readonly tabId: number
  readonly measure: PageCommand
}): Promise<CaptureResponse> {
  const { debuggee, tabId, measure } = input

  if (measure.type === "measure-post") {
    // The debugger is attached as soon as the tab opens, so the banner's resize happens while
    // X loads rather than holding up the measuring.
    const running = await pageScriptRunning(tabId)

    if (running._tag === "err") return failed("load the Post's status page", running.error)

    // Keep the status page rendering without selecting its tab or moving the user's focus.
    const focused = await withinCaptureLimit(
      chrome.debugger.sendCommand(debuggee, "Emulation.setFocusEmulationEnabled", { enabled: true })
    )

    if (focused._tag === "err") return failed("enable background rendering", focused.error)

    const active = await withinCaptureLimit(
      chrome.debugger.sendCommand(debuggee, "Page.setWebLifecycleState", { state: "active" })
    )

    if (active._tag === "err") return failed("activate background rendering", active.error)
  }

  // Attaching shows the "started debugging this browser" banner, which shrinks the viewport.
  // The page measures only once that resize is over: capturing while the page is still
  // resizing produces repeated tiles instead of the Target.
  const measuring = attempt(chrome.tabs.sendMessage<PageCommand, Measurement>(tabId, measure))

  // A background tab that was never shown draws nothing until a screenshot asks it to, and
  // starting to draw takes seconds. Tiny screenshots while the page measures start it early,
  // so the real screenshot doesn't wait for that. They aren't awaited: once the page stops
  // changing, a screenshot can wait for a frame that only the real screenshot's resize draws.
  if (measure.type === "measure-post") void startRendering(debuggee, measuring)

  const measured = await measuring

  if (measured._tag === "err") return failed("measure the Target", measured.error)

  if (measured.value._tag === "refused") return measured.value

  const { crop, devicePixelRatio, destination, warnings } = measured.value

  const zoomed = await pageZoom(debuggee)

  if (zoomed._tag === "err") return failed("read the page's zoom", zoomed.error)

  const zoom = zoomed.value

  const shot = await withinCaptureLimit(
    chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      // The clip is in zoomed pixels: CSS pixels times the browser zoom, which X pages often
      // have. Chromium multiplies it by the screen's pixel ratio as well as by `scale`, and
      // `devicePixelRatio` is the zoom times the screen's pixel ratio, so the image has
      // CAPTURE_SCALE pixels per CSS pixel.
      clip: {
        x: crop.x * zoom,
        y: crop.y * zoom,
        width: crop.width * zoom,
        height: crop.height * zoom,
        scale: CAPTURE_SCALE / devicePixelRatio,
      },
    })
  )

  if (shot._tag === "err") return failed("take the screenshot", shot.error)

  // SAFETY: The protocol defines Page.captureScreenshot's result as `{ data: string }`, the
  // base64-encoded image, and the command resolved without an error.
  const { data } = shot.value as { readonly data: string }

  switch (destination._tag) {
    case "clipboard":
      // The page writes the Clipboard, which a service worker can't reach.
      return { _tag: "captured", pngBase64: data, warnings }
    case "download": {
      const saved = await saveDownload({ pngBase64: data, filename: destination.filename })

      if (saved._tag === "err") return failed("save the Download", saved.error)

      return { _tag: "captured", pngBase64: data, warnings }
    }
  }
}

/**
 * Take one-pixel screenshots, one after another, until the tab draws them quickly or `until`
 * settles.
 */
async function startRendering(
  debuggee: chrome.debugger.Debuggee,
  until: Promise<unknown>
): Promise<void> {
  let settled = false
  let quick = 0
  void until.finally(() => {
    settled = true
  })

  while (!settled && quick < RENDERING_QUICK_SHOTS) {
    const started = performance.now()

    const drawn = await withinCaptureLimit(
      chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
      })
    )

    const took = performance.now() - started

    if (drawn._tag === "err") return

    quick = took < RENDERING_QUICK_MS ? quick + 1 : 0
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
      chrome.downloads.onChanged.removeListener(onDownloadChanged)
      resolve(state === "complete" ? ok(undefined) : err(new Error(error ?? "it was interrupted")))
    }

    function onDownloadChanged(delta: chrome.downloads.DownloadDelta): void {
      const state = delta.state?.current

      if (delta.id !== downloadId || state === undefined) return
      settle(state, delta.error?.current)
    }

    chrome.downloads.onChanged.addListener(onDownloadChanged)

    // The download can finish before the listener is added. Settling twice is harmless.
    void attempt(chrome.downloads.search({ id: downloadId })).then((found) => {
      if (found._tag === "ok" && found.value[0] !== undefined) {
        settle(found.value[0].state, found.value[0].error)
      }
    })
  })
}

/** The browser zoom of the debugged page, such as 1.5 at 150%. */
async function pageZoom(debuggee: chrome.debugger.Debuggee): Promise<Result<number, Error>> {
  const metrics = await withinCaptureLimit(
    chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics")
  )

  if (metrics._tag === "err") return metrics

  // SAFETY: The protocol defines Page.getLayoutMetrics's result to include
  // `cssVisualViewport`, whose `zoom` is optional, and the command resolved without an error.
  const { cssVisualViewport } = metrics.value as {
    readonly cssVisualViewport: { readonly zoom?: number }
  }

  return ok(cssVisualViewport.zoom ?? 1)
}

/** Bound a protocol command; capture's finally detaches even if the command never answers. */
function withinCaptureLimit<T>(operation: Promise<T>): Promise<Result<T, Error>> {
  return new Promise((resolve) => {
    const limit = setTimeout(() => {
      resolve(err(new Error("it took longer than 15 seconds")))
    }, CAPTURE_LIMIT_MS)

    void attempt(operation).then((result) => {
      clearTimeout(limit)
      resolve(result)
    })
  })
}

function failed(step: string, error: Error): CaptureResponse {
  return { _tag: "failed", reason: `Couldn't ${step}: ${error.message}` }
}
