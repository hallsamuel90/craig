---
"craig-cli": patch
---

Fix PTY session content not rendering after boot overlay dismiss

The pre-hydrate fix from #81 fired `hydrateOpenPtyTabs()` as fire-and-forget at boot and then launched a *second* concurrent call via `hydrateAndRenderOpenPtyTabs()` when the user pressed Enter. The two concurrent hydrations raced on the daemon socket, making the post-Enter re-render unreliable.

Now the boot hydration promise is stored as `bootHydrationReady` and the Enter handler chains its re-render directly onto that promise — a single hydration, guaranteed re-render once it completes, no concurrent duplicate.
