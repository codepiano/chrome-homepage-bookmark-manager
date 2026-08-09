# Ralph context snapshot

- **Task statement**: Implement the approved local Chrome quick-access/new-tab extension plan.
- **Desired outcome**: A loadable MV3 Chrome extension and local backend that manage a fresh bookmark library, metadata, configurable text-first views, drag sorting, and persisted click analytics.
- **Known evidence**: The workspace has no source code; the approved plan is `.omx/plans/chrome-local-speed-dial-plan.md`. The reference image establishes a compact, settings-led Speed Dial-inspired visual direction, not a pixel-perfect clone.
- **Constraints**: Single local user; no account, sync, Chrome native bookmark import, or webpage thumbnail capture. Backend is the data authority. Do not expose the API outside loopback. Use no cloud dependency.
- **Unknowns/open questions**: Exact final color/font preferences are not specified; use a clean system-font adaptive default and make colors/layout configurable. The extension ID is unknown until Chrome loads the unpacked build, so local pairing must work without a hard-coded extension ID.
- **Likely touchpoints**: New pnpm workspace; `apps/server`, `apps/extension`, `packages/contracts`, tests, README, and extension manifest.
- **Execution risk**: The supplied image is a settings reference only; no generated application screenshot exists yet, so visual comparison begins only after the first runnable UI capture.
