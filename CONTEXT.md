# XShot

A browser extension that turns one element on a page into a single tightly cropped, full-height image. It works on any site, but X posts are the focus: on X it understands Posts and the conversation around them.

## Language

### What gets captured

**Post**:
One X status as rendered on the page: author, text, media, quoted post, timestamp, engagement counts and any community note.
_Avoid_: Tweet, status, article, comment

**Reply**:
A Post written in response to another Post. It is still a Post; "reply" only describes its place in a conversation.
_Avoid_: Comment

**Conversation**:
The chain of Posts from a root Post down to a given Post, each one replying to the one above it. A Post that isn't a Reply is a Conversation of one. It never includes Replies below the given Post.
_Avoid_: Thread, chain, context

**Focal post**:
The Post a status page is about, as opposed to the Posts above and below it in the conversation.
_Avoid_: Main tweet, selected post

**Target**:
What a Capture shows. For a Post Capture it is the Conversation ending at the Post the user right-clicked, as that Post's own status page renders it; for a Pick Capture it is the element the user chose.
_Avoid_: Node, element, selection

**Clutter**:
Page interface inside a Post that isn't content, removed before any Capture whose Target contains a Post: the reply composer, "Relevant people" and "Discover more" sections, the "Show translation" button (formerly the "Translate post" link), the "…" menu button, and the Grok actions button.
_Avoid_: Noise, junk, chrome

**Truncated**:
Describes a Post or quoted post whose text X has shortened behind "Show more". A Post Capture expands truncated text first; a Pick Capture shows it as rendered.
_Avoid_: Collapsed, cut off

### How a capture starts

**Capture**:
One image of one Target at full height, however much of it is visible on screen, and exactly as the page renders it (theme, current video or GIF frame).
_Avoid_: Screenshot, snap, shot

**Partial Capture**:
A Capture produced even though part of its content couldn't be loaded or expanded (including a Post X shows as unavailable), delivered with a warning instead of silently.
_Avoid_: Incomplete capture, failed capture

**Oversized**:
Describes a Target too tall to fit in one image at full sharpness. An Oversized Target is refused, never scaled down or split.
_Avoid_: Too long, overflow

**Post Capture**:
A Capture started from the page's right-click menu on a Post: "Screenshot post" or "Screenshot post to file". Right-clicking inside a quoted post captures the Post that quotes it. Only offered on X.
_Avoid_: Context-menu screenshot, quick capture

**Pick mode**:
The temporary state, entered from the toolbar button, in which a highlight follows the cursor, can be widened to the enclosing element or narrowed back, and a click chooses the Target. Escape leaves it without capturing. Available on any site.
_Avoid_: Inspector, selector mode, picker

**Pick Capture**:
A Capture whose Target was chosen in Pick mode.
_Avoid_: Element screenshot, node screenshot

### Where it goes

**Destination**:
Where a finished Capture is delivered: the **Clipboard** (default) or a **Download** (a PNG file), chosen per Capture rather than as a setting.
_Avoid_: Output, export

**Confirmation**:
The brief on-page notice after every Capture attempt: a thumbnail of what was delivered and any Partial Capture warning, or the reason nothing was captured (no Post under the cursor, Oversized).
_Avoid_: Toast, popup, notification
