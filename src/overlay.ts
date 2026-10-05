/** UI that XShot puts on a page, isolated from the page's styles in a closed Shadow DOM. */
export type Overlay = {
  /** Where the overlay's elements go. */
  readonly root: ShadowRoot

  /** Take the overlay off the page. */
  readonly remove: () => void
}

/**
 * Put an overlay on the page above everything else, without catching the pointer.
 *
 * Styles are set through the CSSOM (`style.cssText` and a constructed stylesheet) rather than
 * markup, because a page's Content Security Policy can block inline `<style>` and `style=""`.
 *
 * @param input - The overlay's element name and the CSS for its contents.
 * @returns The mounted overlay.
 */
export function mountOverlay(input: { readonly name: string; readonly css: string }): Overlay {
  const host = document.createElement(input.name)
  host.style.cssText = [
    "all: initial !important",
    "position: fixed !important",
    "inset: 0 auto auto 0 !important",
    "z-index: 2147483647 !important",
    "pointer-events: none !important",
  ].join(";")

  const root = host.attachShadow({ mode: "closed" })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(input.css)
  root.adoptedStyleSheets = [sheet]
  document.documentElement.append(host)

  return { root, remove: () => host.remove() }
}
