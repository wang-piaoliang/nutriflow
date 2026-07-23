# NutriFlow Repository Rules

## Start Every Task Here

1. Read `NUTRIFLOW_PROJECT_CONTEXT.md` before inspecting or changing code.
2. If `.nutriflow-private-context.md` exists locally, read it for personalization constraints. Never quote, publish, stage, or commit that file.
3. Run `git status --short` and `git log -5 --oneline` so current work and recent user changes are preserved.

## Source Of Truth

- The current product is the mobile-first PWA in `public/nutriflow.html`.
- PWA metadata and offline behavior live in `public/manifest.webmanifest` and `public/sw.js`.
- `app/page.tsx` and `public/index.html` redirect the root route to `/nutriflow.html`.
- Purchase and food data are currently hardcoded in `public/nutriflow.html`.
- The consumed checkbox state is device-local in `localStorage` under `nutriflow_consumed_v1`.

## Required Context Update

After every code, content, nutrition-rule, purchase-data, or deployment change:

1. Update `NUTRIFLOW_PROJECT_CONTEXT.md` in the same change.
2. Refresh its date, current behavior, recent changes, known issues, deployment status, and next steps as applicable.
3. Keep the changelog concise and newest first.
4. Update `.nutriflow-private-context.md` only when private health or personalization facts change.
5. Commit the context update together with the implementation. Do not put a self-referential commit hash in the context; a new task should read `git log` for the exact current commit.

## Publishing Policy

- Use the `github` remote for the public NutriFlow repository. The legacy `origin` remote is retained only as history and is not the deployment target.
- After every change: update `NUTRIFLOW_PROJECT_CONTEXT.md`, commit the change, then run `npm run publish:pages` in the same task. Do not wait to batch later changes.
- For every substantial user-visible change, publishing is the default final step and needs no separate confirmation. Do not stop after implementation or present publishing as a later optional action; report implementation and publication together at final handoff.
- `npm run publish:pages` validates the app, pushes source to `main`, publishes `public/` to `gh-pages`, then requests a Pages rebuild.
- Large changes must be published before handoff. This includes navigation, page layout, purchase or food data structure, offline behavior, installation behavior, and nutrition rules.
- Small user-visible changes should normally be published in the same turn. Documentation-only changes may normally be committed without a deployment when they do not affect the site, except when the user explicitly requests immediate publication.
- Record the publish result and any deployment issue in `NUTRIFLOW_PROJECT_CONTEXT.md`.

## Data Intake

- Treat a pasted `NutriFlow 同步包` as structured input from the user's separate mobile ChatGPT conversation.
- Deduplicate purchases by stable record ID when present; otherwise compare receipt date, store, item, amount, and price.
- Current intake scope (updated 2026-07-23): the purchase record is COMPLETE. Record every purchased item on the receipt, including staples (rice, noodles, bread), cooking oil, salt, seasonings, milk and other pantry goods — not only fresh cooking ingredients. Still deduplicate genuine duplicate lines by the stable record ID rule above.
- Pantry vs fresh: staples/oil/salt/seasonings/pantry goods are logged with `pantry:true`. A `pantry:true` item appears in the receipt history, its receipt category-weight summary, the 食材 weekly-bought total and the 元/kg price comparison, but is kept OUT of the 现有食材 "check off when eaten" list (and its 已吃完历史). The shopping bag stays excluded from that list via `foodId:"bag"` as before. Fresh ingredients (meat, seafood, vegetables, eggs, tofu, fruit/nuts) are NOT `pantry` and do enter 现有食材.
- Keep one receipt-level store/date/total summary and place individual products beneath it.
- Preserve raw uncertainty. Mark unreadable receipt fields as `待确认`; do not invent values.
- Meal records and purchase records may be public because the user explicitly approved this. Do not publish payment details, phone numbers, membership IDs, exact home addresses, barcodes, medical documents, or private health measurements.

## Product And Quality Rules

- Design for iPhone first. There must be no horizontal page scrolling at mobile widths.
- Keep body text smaller than section titles and make long nutrition text wrap vertically.
- Preserve the four-tab order: `首页`, `食材`, `饮食`, `采购`.
- Use authoritative nutrition guidance and clearly label personalized priority scores as guidance, not medical diagnosis.
- When the app shell changes, bump the service-worker cache name and update its test assertion.
- Run `npm test` and `git diff --check` after relevant changes. For layout changes, also verify at a narrow mobile viewport and a desktop viewport.
- Never revert unrelated user changes.
