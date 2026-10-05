# Capture the rendered page instead of rebuilding posts from the X API

XShot captures the post as X already renders it in the user's logged-in browser, using the same full-node screenshot mechanism as DevTools' "Capture node screenshot". It does not rebuild the post from X API data, which was the earlier plan for a public web app (patrickhaahr/xshot#1). Capturing the page is free, works on anything the user can see (including protected and logged-in content), and is pixel-faithful by definition. The cost is that it depends on X's page markup, which changes without notice, and it only works in a browser where the user is logged in.

## Considered Options

- **Public web app using the X API** (issue #1): links work without a login and the look stays consistent, but the API is paid, needs rate limits and a budget cap, the rebuilt post can drift from what X actually shows, and it's far more work.
- **Scroll-and-stitch screen capture**: sticky headers and floating controls repeat in every slice, and lazy-loaded media shifts the layout between frames.

## Consequences

- XShot is Chromium-only. Capturing an element beyond the viewport relies on the Chromium debugger API, which Firefox doesn't have.
