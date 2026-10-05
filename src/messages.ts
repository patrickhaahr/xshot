// Messages between the background worker and the page script. Only XShot's own scripts can
// send runtime messages (the manifest has no `externally_connectable`), and both sides type
// their sends and listeners with these definitions, so a received message has this form.

import type { Rect } from "./capture-plan"

/** A command the background worker sends to the page script. */
export type PageCommand =
  /** The toolbar button was clicked. */
  | { readonly type: "enter-pick-mode" }
  /** The debugger is attached: wait for the viewport to settle, then measure the Target. */
  | { readonly type: "measure" }

/** The Target's crop, measured in the page once the viewport has settled. */
export type Measurement = {
  readonly crop: Rect

  /** `window.devicePixelRatio`, which Chromium multiplies into every screenshot. */
  readonly devicePixelRatio: number
}

/** A request the page script sends to the background worker. */
export type WorkerRequest = { readonly type: "capture" }

/** The background worker's answer to a capture request. */
export type CaptureResponse =
  | { readonly _tag: "captured"; readonly pngBase64: string }
  | { readonly _tag: "failed"; readonly reason: string }
