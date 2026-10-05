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
 * Enter Pick mode: a highlight follows the element under the cursor until a click chooses it.
 * The highlight is gone by the time the promise resolves.
 *
 * @returns The element the user clicked.
 */
export function pick(): Promise<Element> {
  const overlay = mountOverlay({ name: "xshot-pick-mode", css: HIGHLIGHT_CSS })
  const highlight = document.createElement("div")
  highlight.className = "highlight"
  highlight.hidden = true
  overlay.root.append(highlight)

  let hovered: Element | null = null

  function cover(): void {
    if (hovered === null) return
    const bounds = hovered.getBoundingClientRect()
    highlight.hidden = false
    highlight.style.left = `${bounds.left}px`
    highlight.style.top = `${bounds.top}px`
    highlight.style.width = `${bounds.width}px`
    highlight.style.height = `${bounds.height}px`
  }

  function follow(event: MouseEvent): void {
    if (!(event.target instanceof Element) || event.target === hovered) return
    hovered = event.target
    cover()
  }

  return new Promise((resolve) => {
    function choose(event: MouseEvent): void {
      if (!(event.target instanceof Element)) return
      window.removeEventListener("mousemove", follow, true)
      window.removeEventListener("scroll", cover, true)
      window.removeEventListener("click", choose, true)
      overlay.remove()
      resolve(event.target)
    }

    window.addEventListener("mousemove", follow, true)
    window.addEventListener("scroll", cover, { capture: true, passive: true })
    window.addEventListener("click", choose, true)
  })
}
