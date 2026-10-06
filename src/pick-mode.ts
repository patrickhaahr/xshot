import type { Destination } from "./capture-plan"
import { mountOverlay } from "./overlay"

const HIGHLIGHT_CSS = `
  .highlight {
    position: fixed;
    box-sizing: border-box;
    border: 2px solid #1d9bf0;
    border-radius: 2px;
    background: rgb(29 155 240 / 0.15);
    pointer-events: none;
  }
`

/**
 * Wheel travel, in CSS pixels, that widens or narrows the highlight by one more element while
 * the wheel keeps turning. The first turn after a pause always moves one element, so a single
 * notch of a mouse wheel does, however few pixels the platform reports for it.
 */
const WHEEL_STEP_PX = 50

/** A pause between wheel events this long starts a new turn of the wheel. */
const WHEEL_PAUSE_MS = 200

/**
 * Button events that would press, focus, select text in or activate something on the page.
 * Pick mode keeps all of them from the page so that the choosing click does nothing there.
 */
const PRESS_EVENTS = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
] as const

/** A click chose the highlighted element as the Target. */
export type Picked = {
  readonly _tag: "picked"
  readonly target: Element

  /** A Download for Shift+click, the Clipboard for a plain click. */
  readonly destination: Destination
}

/** How Pick mode ended. */
export type PickOutcome =
  | Picked
  /** Escape left Pick mode without choosing anything. */
  | { readonly _tag: "cancelled" }

/**
 * Enter Pick mode: a highlight follows the element under the cursor, ↑ or the wheel turned up
 * widens it to the enclosing element, ↓ or the wheel turned down narrows it back the way it
 * came, a click chooses it and Escape leaves.
 *
 * While Pick mode lasts the page receives no button presses. Unmodified ↑ / ↓ and vertical
 * wheel turns navigate the highlight instead of scrolling; other scrolling keys, sideways
 * wheel turns and Ctrl+wheel keep their normal behaviour. When the promise resolves, the
 * highlight and every listener are gone, so the page behaves as before.
 *
 * @returns The element the user chose and where its Capture goes, or that they cancelled.
 */
export function pick(): Promise<PickOutcome> {
  const overlay = mountOverlay({ name: "xshot-pick-mode", css: HIGHLIGHT_CSS })
  const highlight = document.createElement("div")
  highlight.className = "highlight"
  highlight.hidden = true
  overlay.root.append(highlight)

  const listening = new AbortController()

  /** The element under the cursor. */
  let hovered: Element | null = null

  /** What a click would choose: the hovered element or, after widening, one enclosing it. */
  let highlighted: Element | null = null

  /** The elements narrowing goes back through, the next one last. Empty unless widened. */
  let narrower: Element[] = []

  let wheelDirection = 0
  let wheelTravel = 0
  let lastWheelAt = Number.NEGATIVE_INFINITY

  function cover(): void {
    if (highlighted === null) return
    const bounds = highlighted.getBoundingClientRect()
    highlight.hidden = false
    highlight.style.left = `${bounds.left}px`
    highlight.style.top = `${bounds.top}px`
    highlight.style.width = `${bounds.width}px`
    highlight.style.height = `${bounds.height}px`
  }

  function followCursor(event: MouseEvent): void {
    if (!(event.target instanceof Element) || event.target === hovered) return
    hovered = event.target

    // Moving to a different element starts a new path. Movement within the same hovered
    // element returned above, preserving the widened highlight and the actual widen stack.
    highlighted = hovered
    narrower = []

    cover()
  }

  function widen(): void {
    const enclosing = highlighted?.parentElement

    if (highlighted === null || enclosing === null || enclosing === undefined) return
    narrower.push(highlighted)
    highlighted = enclosing
    cover()
  }

  function narrow(): void {
    const previous = narrower.pop()

    if (previous === undefined) return
    highlighted = previous
    cover()
  }

  function turnWheel(event: WheelEvent): void {
    // Ctrl+wheel is the browser's zoom; a purely sideways turn neither widens nor narrows.
    if (event.ctrlKey || event.deltaY === 0) return
    event.preventDefault()
    event.stopImmediatePropagation()

    const direction = Math.sign(event.deltaY)

    const pixels =
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? Math.abs(event.deltaY) : WHEEL_STEP_PX

    const freshTurn = event.timeStamp - lastWheelAt > WHEEL_PAUSE_MS || direction !== wheelDirection

    lastWheelAt = event.timeStamp
    wheelDirection = direction
    wheelTravel = freshTurn ? WHEEL_STEP_PX : wheelTravel + pixels

    if (wheelTravel < WHEEL_STEP_PX) return
    wheelTravel = 0

    if (direction < 0) {
      widen()
    } else {
      narrow()
    }
  }

  return new Promise((resolve) => {
    function finish(outcome: PickOutcome): void {
      listening.abort()
      overlay.remove()
      resolve(outcome)
    }

    function press(event: MouseEvent): void {
      event.preventDefault()
      event.stopImmediatePropagation()

      if (event.type !== "click") return
      followCursor(event)

      if (highlighted === null) return

      finish({
        _tag: "picked",
        target: highlighted,
        destination: event.shiftKey ? "download" : "clipboard",
      })
    }

    function navigate(event: KeyboardEvent): void {
      // Leave the browser's and the system's shortcuts alone.
      if (event.ctrlKey || event.metaKey || event.altKey) return

      switch (event.key) {
        case "ArrowUp":
          widen()
          break
        case "ArrowDown":
          narrow()
          break
        case "Escape":
          finish({ _tag: "cancelled" })
          break
        default:
          return
      }

      event.preventDefault()
      event.stopImmediatePropagation()
    }

    // Listening on the window in the capture phase runs before any of the page's own
    // listeners on its elements, so stopping an event there keeps it from the page.
    const options = { capture: true, signal: listening.signal }
    window.addEventListener("mousemove", followCursor, options)
    window.addEventListener("scroll", cover, { ...options, passive: true })
    window.addEventListener("wheel", turnWheel, { ...options, passive: false })
    window.addEventListener("keydown", navigate, options)

    for (const type of PRESS_EVENTS) window.addEventListener(type, press, options)
  })
}
