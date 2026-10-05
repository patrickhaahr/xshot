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

/** The longest wait for a Post's status page to load in its background tab. */
const STATUS_PAGE_LOAD_LIMIT_MS = 30_000

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
  void startPostCapture({
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
        void captureFromStatusPage(request, {
          tabId: tab.id,
          index: tab.index,
          windowId: tab.windowId,
        }).then(sendResponse)
        break
    }

    return true
  }
)

/** Tell the right-clicked page to start a Post Capture from the element under the right-click. */
async function startPostCapture(input: {
  readonly tabId: number
  readonly frameId: number
  readonly destination: Destination
}): Promise<void> {
  // The page script runs on every X page from the manifest, so it saw the right-click. It is
  // missing only from X tabs opened before XShot was installed or reloaded.
  const delivered = await attempt(
    chrome.tabs.sendMessage<PageCommand>(
      input.tabId,
      { type: "start-post-capture", destination: input.destination },
      { frameId: input.frameId }
    )
  )

  if (delivered._tag === "err") {
    console.warn(`XShot isn't loaded on this page; reload it: ${delivered.error.message}`)
  }
}

/**
 * Capture a Post from its own status page, opened in a background tab next to the page it was
 * right-clicked on and closed afterwards, so the user stays where they are.
 */
async function captureFromStatusPage(
  request: Extract<WorkerRequest, { readonly type: "capture-post" }>,
  opener: { readonly tabId: number; readonly index: number; readonly windowId: number }
): Promise<CaptureResponse> {
  const created = await attempt(
    chrome.tabs.create({
      url: statusPageUrl(request.start.post),
      active: false,
      index: opener.index + 1,
      windowId: opener.windowId,
      openerTabId: opener.tabId,
    })
  )

  if (created._tag === "err") return failed("open the Post's status page", created.error)

  const tabId = created.value.id

  if (tabId === undefined) return { _tag: "failed", reason: "Couldn't open the Post's status page" }

  try {
    const loaded = await tabLoaded(tabId)

    if (loaded._tag === "err") return failed("load the Post's status page", loaded.error)

    return await capture(tabId, {
      type: "measure-post",
      start: request.start,
      destination: request.destination,
    })
  } finally {
    await attempt(chrome.tabs.remove(tabId))
  }
}

/** Resolve once a tab has finished loading, or with an error if it closes or takes too long. */
function tabLoaded(tabId: number): Promise<Result<void, Error>> {
  return new Promise((resolve) => {
    const limit = setTimeout(() => {
      settle(err(new Error("it took too long")))
    }, STATUS_PAGE_LOAD_LIMIT_MS)

    function settle(result: Result<void, Error>): void {
      clearTimeout(limit)
      chrome.tabs.onUpdated.removeListener(follow)
      chrome.tabs.onRemoved.removeListener(closed)
      resolve(result)
    }

    function follow(updatedId: number, change: chrome.tabs.OnUpdatedInfo): void {
      if (updatedId === tabId && change.status === "complete") settle(ok(undefined))
    }

    function closed(removedId: number): void {
      if (removedId === tabId) settle(err(new Error("its tab was closed")))
    }

    chrome.tabs.onUpdated.addListener(follow)
    chrome.tabs.onRemoved.addListener(closed)

    // The tab can finish loading before the listeners are added. Settling twice is harmless.
    void attempt(chrome.tabs.get(tabId)).then((found) => {
      if (found._tag === "ok" && found.value.status === "complete") settle(ok(undefined))
    })
  })
}

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

  // Attaching shows the "started debugging this browser" banner, which shrinks the viewport.
  // The page measures only once that resize is over: capturing while the page is still
  // resizing produces repeated tiles instead of the Target.
  const measured = await attempt(chrome.tabs.sendMessage<PageCommand, Measurement>(tabId, measure))

  if (measured._tag === "err") return failed("measure the Target", measured.error)

  if (measured.value._tag === "refused") return measured.value

  const { crop, devicePixelRatio, destination, warnings } = measured.value

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
      return { _tag: "captured", pngBase64: data, warnings }
    case "download": {
      const saved = await saveDownload({ pngBase64: data, filename: destination.filename })

      if (saved._tag === "err") return failed("save the Download", saved.error)

      return { _tag: "captured", pngBase64: data, warnings }
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
