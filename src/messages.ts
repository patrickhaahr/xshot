// Messages between the background worker and the page script. Only XShot's own scripts can
// send runtime messages (the manifest has no `externally_connectable`), and both sides type
// their sends and listeners with these definitions, so a received message has this form.

import type {
  CaptureRefusal,
  CaptureWarning,
  Destination,
  DestinationPlan,
  PostCaptureStart,
  Rect,
} from "./capture-plan"

/** A command the background worker sends to the page script. */
export type PageCommand =
  /** The toolbar button was clicked. */
  | { readonly type: "enter-pick-mode" }
  /** The debugger is attached: wait for the viewport to settle, then measure the picked Target. */
  | { readonly type: "measure" }
  /** A Post Capture was chosen from the right-click menu: start it from the right-clicked element. */
  | { readonly type: "start-post-capture"; readonly destination: Destination }
  /**
   * The debugger is attached to the clicked Post's status page, opened in a background tab:
   * wait for the Post to render and the viewport to settle, then measure the Target.
   */
  | {
      readonly type: "measure-post"
      readonly start: PostCaptureStart
      readonly destination: Destination
    }

/** The page's answer to a measure command, once the viewport has settled. */
export type Measurement =
  | {
      readonly _tag: "measured"

      /** The Target's crop. */
      readonly crop: Rect

      /** `window.devicePixelRatio`, which Chromium multiplies into every screenshot. */
      readonly devicePixelRatio: number

      /** Where the Capture is delivered: the worker saves a Download, the page fills the Clipboard. */
      readonly destination: DestinationPlan

      /** Why the Capture is a Partial Capture; empty when it is complete. */
      readonly warnings: ReadonlyArray<CaptureWarning>
    }
  /** The Capture plan refused the Target, so no screenshot is taken. */
  | { readonly _tag: "refused"; readonly refusal: CaptureRefusal }

/** A request the page script sends to the background worker. */
export type WorkerRequest =
  /** Capture the Target picked on the sending page. */
  | { readonly type: "capture" }
  /** Capture a Post from its own status page, opened in a background tab. */
  | {
      readonly type: "capture-post"
      readonly start: PostCaptureStart
      readonly destination: Destination
    }

/**
 * The background worker's answer to a capture request. A Download is already saved when the
 * answer is "captured"; the image comes back for the Clipboard and the Confirmation.
 */
export type CaptureResponse =
  | {
      readonly _tag: "captured"
      readonly pngBase64: string

      /** Why it is a Partial Capture, for the Confirmation; empty when it is complete. */
      readonly warnings: ReadonlyArray<CaptureWarning>
    }
  | { readonly _tag: "refused"; readonly refusal: CaptureRefusal }
  | { readonly _tag: "failed"; readonly reason: string }
