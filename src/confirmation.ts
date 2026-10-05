import type { CaptureRefusal, CaptureWarning } from "./capture-plan"
import { mountOverlay } from "./overlay"
import type { Overlay } from "./overlay"
import { casesHandled } from "./prelude"

/** How long a Confirmation stays on the page. */
const VISIBLE_MS = 3000

/** The largest thumbnail side, in CSS pixels. */
const THUMBNAIL_MAX = 200

const CONFIRMATION_CSS = `
  .confirmation {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: grid;
    gap: 8px;
    justify-items: start;
    padding: 12px;
    border-radius: 12px;
    background: #ffffff;
    color: #0f1419;
    box-shadow: 0 4px 24px rgb(0 0 0 / 0.2);
    font: 500 14px/1.3 system-ui, sans-serif;
  }
  .thumbnail {
    border-radius: 4px;
    outline: 1px solid rgb(0 0 0 / 0.1);
  }
  .warning {
    color: #9a4d00;
  }
  @media (prefers-color-scheme: dark) {
    .confirmation {
      background: #16181c;
      color: #e7e9ea;
    }
    .warning {
      color: #ffb45c;
    }
    .thumbnail {
      outline-color: rgb(255 255 255 / 0.15);
    }
  }
`

let current: Overlay | null = null

/**
 * Show a Confirmation with a thumbnail of the Capture, replacing any earlier one. It removes
 * itself after a few seconds.
 *
 * @param png - The Capture that was delivered.
 * @param message - What happened to it, such as "Copied to Clipboard".
 * @param warnings - Why it is a Partial Capture; empty when it is complete.
 */
export async function showConfirmation(
  png: Blob,
  message: string,
  warnings: ReadonlyArray<CaptureWarning>
): Promise<void> {
  // A canvas rather than an <img>, because a page's Content Security Policy can block blob:
  // and data: images.
  const image = await createImageBitmap(png)
  const fit = Math.min(1, THUMBNAIL_MAX / Math.max(image.width, image.height))
  const width = image.width * fit
  const height = image.height * fit
  const thumbnail = document.createElement("canvas")
  thumbnail.className = "thumbnail"
  thumbnail.width = Math.round(width * window.devicePixelRatio)
  thumbnail.height = Math.round(height * window.devicePixelRatio)
  thumbnail.style.width = `${width}px`
  thumbnail.style.height = `${height}px`
  thumbnail.getContext("2d")?.drawImage(image, 0, 0, thumbnail.width, thumbnail.height)
  image.close()

  show([thumbnail, text(message), ...warnings.map(warning)])
}

/** A Partial Capture's warning, set apart from the message so it isn't missed. */
function warning(partial: CaptureWarning): HTMLSpanElement {
  const span = text(warningMessage(partial))
  span.className = "warning"

  return span
}

function warningMessage(partial: CaptureWarning): string {
  switch (partial._tag) {
    case "unavailable-posts":
      return partial.count === 1
        ? "Partial Capture: 1 Post in the Conversation is unavailable."
        : `Partial Capture: ${partial.count} Posts in the Conversation are unavailable.`
    case "not-expanded":
      return 'Partial Capture: some "Show more" text couldn\'t be expanded.'
    case "quoted-post-cut-off":
      return "Partial Capture: X shows only the start of a quoted post."
    case "root-post-missing":
      return "Partial Capture: the Conversation doesn't start at the root Post."
    default:
      return casesHandled(partial)
  }
}

/**
 * Show a Confirmation that nothing was delivered, without a thumbnail, so an image from an
 * earlier Capture isn't mistaken for this one. Replaces any earlier Confirmation.
 *
 * @param reason - Why nothing was delivered, such as a failed Clipboard write.
 */
export function showFailure(reason: string): void {
  show([text(reason)])
}

/**
 * Show a Confirmation explaining why the Capture plan refused the Target, without a
 * thumbnail. Replaces any earlier Confirmation.
 *
 * @param refusal - Why nothing was captured.
 */
export function showRefusal(refusal: CaptureRefusal): void {
  switch (refusal._tag) {
    case "oversized":
      show([
        text("Too tall to capture in one image."),
        text("Use Pick mode to capture a smaller part."),
      ])

      return
    case "no-post":
      show([text("No Post here")])

      return
    case "post-not-shown":
      show([text("Couldn't find this Post on its status page.")])

      return
    default:
      casesHandled(refusal)
  }
}

function text(message: string): HTMLSpanElement {
  const span = document.createElement("span")
  span.textContent = message

  return span
}

/** Show a Confirmation card with the given contents for a few seconds. */
function show(contents: ReadonlyArray<HTMLElement>): void {
  const card = document.createElement("div")
  card.className = "confirmation"
  card.setAttribute("role", "status")
  card.append(...contents)

  dismissConfirmation()
  const overlay = mountOverlay({ name: "xshot-confirmation", css: CONFIRMATION_CSS })
  overlay.root.append(card)
  current = overlay
  setTimeout(() => {
    overlay.remove()

    if (current === overlay) current = null
  }, VISIBLE_MS)
}

/** Remove the Confirmation, if one is showing. */
export function dismissConfirmation(): void {
  current?.remove()
  current = null
}
