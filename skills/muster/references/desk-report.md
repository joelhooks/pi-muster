# Desk report

When a desk holds several decisions for Joel, it publishes one feedback page in this shape instead of a chat digest. Joel ticks, writes notes, and pastes the feedback back. The desk turns that into rulings: it resolves each item, then sends the owner one message.

## Build and apply

1. Write the items JSON in the `muster-desk-report.items.v1` shape (see below). Each card is written for its own decision; no card is a copy of another.
2. Run `desk_report {report, out, scan}`. It renders `<out>/index.html` in the ratstack look. It refuses a page that holds links or email addresses, and it runs the project's own redaction scan, with `PAGE` set to the page path.
3. Publish the page noindex with a 48-hour expiry (`wzrrd publish --expires-in 48h`). Check for HTTP 200 and an `x-robots-tag` noindex. Look at the rendered page before sharing the link.
4. Joel pastes the feedback. Run `desk_rulings {project, report, feedback}`, using `dryRun` first when unsure. Each answered card resolves every desk item it covers. Send the returned owner message once.
5. Keep a manifest next to the items: the slug, URL, expiry, desk item IDs, and publish receipts.

## Look

The look is ratstack.sh, from the wzrrd template `joel/ratstack-mdsvx` `app.css`, inlined verbatim. That means system monospace, an 80-character column, and default colors. Controls are browser defaults. Nothing is themed. Every page title starts with `🐀`. Decorative inline Hugeicons (free stroke-rounded set) sit beside group, kind, priority, caution, and copy labels; words and feedback stay unchanged.

## Page

The page runs in this order, and every part is data in the items file:

1. A nav line of the group anchors.
2. The title, with the item count and the snapshot time.
3. One plain paragraph on what is going on (`intro`).
4. A `Before you act.` box (`before`). It says nothing has executed, that suggestions are only pre-ticked, that a note overrides the ticks, and how to paste the feedback.
5. **Do first** (`doFirst`): the one card that unblocks the most.
6. `Waiting on you`: a numbered list that links to every card.
7. The groups, in unblock order. For example: policy calls, then money, deals, account requests, and housekeeping.

## Card

- **Title:** the question, in plain words.
- **Kicker:** the kind, the desk IDs, and the age.
- **`why`:** the stakes, in one line.
- **`timeline`** (shown as **So far.**): one line of history.
- **`shows` and `not_shows`:** the evidence both ways.
- **`drafts`:** the exact text, folded away, with names masked.
- **`choices`:** one per real decision axis. A card can have several, such as stacking and expiry. Each option is a plain action with a `then:` line that gives its consequence. The suggestion is pre-ticked and marked "(suggested)". The selected state reads `[x] selected` in text, never by color alone.
- **`rows`:** checkboxes, only when Joel may approve some rows and not others.
- **Note:** free text that overrides the ticks.
- **`refs`:** labels only. Links never reach the page.

Items of the same class share one card, listed with `extra_ids`, so they get consistent answers.

## Feedback

`copy feedback` emits compact JSON (`muster-desk-feedback.v1`) keyed by desk item ID. Each item holds its axis values, its row arrays, and an optional `t` note. The feedback carries no names, URLs, or customer text. Browser state saves under `seed`; bump the seed when the cards change.

Pasted feedback is operator intent only. The owner still runs stale checks, exact-text gates, and provider readback before any send, charge, void, or delete.

## Privacy

- Mask personal names in the text and drafts.
- Keep no provider IDs or URLs on the page.
- Pass `desk_report` the project's redaction scan, and require zero hits.
- Publish only noindex, with a 48-hour expiry.
