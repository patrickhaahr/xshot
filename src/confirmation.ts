import { mountOverlay } from "./overlay"
import type { Overlay } from "./overlay"

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
  @media (prefers-color-scheme: dark) {
    .confirmation {
      background: #16181c;
      color: #e7e9ea;
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
 */
export async function showConfirmation(png: Blob, message: string): Promise<void> {
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

  show([thumbnail, text(message)])
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
