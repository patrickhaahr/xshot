# Capture a Post in place when the page already shows its Conversation

A Post Capture's Target is the Conversation as the Post's own status page renders it, so every Post Capture used to open that status page in a background tab, measure it there and close the tab. The tab flashes in the tab strip and costs a full page load. Now a Post Capture is measured on the right-clicked page when that page already shows the whole Conversation: the Focal post of the status page the user is on, or a Post that is neither a Reply nor Truncated, which is a Conversation of one. Only the other Post Captures (a Reply whose Posts above aren't on the page, a Truncated Post in a timeline, any Post other than the Focal post on a status page) still open the background tab.

An in-place Post Capture uses the Pick Capture's path (the page measures when the worker has attached the debugger, then puts the page back) with the Post Capture's plan: Clutter removal, expanded Truncated text, the Post not shown refusal and the Partial Capture warnings. A Focal post is scrolled to its root Post first, and the user's scroll position is restored afterwards; expanded text stays expanded.

## Considered Options

- **Always use the background tab**: one path and no changes to the user's page, but a new tab for every Capture, even when the page already shows exactly what the tab would.
- **Always capture in place**: no tab ever, but the Posts above a Reply in a timeline aren't on the page, and X can render the Conversation differently there than on the status page.
- **Also expand Truncated timeline Posts in place**: saved timelines show X's "Show more" expanding the text in place, so this could work too. Truncated timeline Posts stay on the background tab for now, which leaves the timeline as the user left it; a Focal post's text is expanded in place, as the status page itself offers.

## Consequences

- A Post captured in place in a timeline looks as the timeline shows it, not as a Focal post: the relative time ("2h") instead of the full date and view count, and the timeline's tighter layout. Its content and Clutter removal are the same. A Focal post captured in place is the same image as one captured in the background tab.

- A timeline Reply is recognised by X's line from the Post above or its "Replying to" line. The latter has no test id and is translated, so it is matched by its structure (an "@handle" profile link outside the Post's author, text and quoted post). A Reply it misses is captured alone, without the Posts above it.
- The user sees their page briefly change during an in-place Capture (the scrollbar and Clutter disappear, a Focal post's page scrolls to the root), as with a Pick Capture.
