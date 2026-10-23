# Keir mobile redesign evidence

Before and after the 2.4.0 redesign, captured on an iPhone 17 Pro simulator
from the built-in UI-test fixtures. Both sets launch with
`--uitest-fixtures --uitest-dev-partner`, so the data on screen is identical.

| Screen | Before | After |
| --- | --- | --- |
| Feed | `before-feed.png` | `after-feed.png` |
| Keir | `before-keir.png` | `after-keir.png` |
| Ops | `before-ops.png` | `after-ops.png` |
| Keir menu | `before-keir-menu.png` | `after-keir-menu.png` |

The before set comes from the temporary evidence branch built at `f1bbcc2`
(workflow run 39960280174). The after set comes from the redesign branch
`keir-mobile-briefing`. Screenshots are exported by the iOS workflow's
`xcresulttool export attachments` step; these files are the four named
attachments from each run.
