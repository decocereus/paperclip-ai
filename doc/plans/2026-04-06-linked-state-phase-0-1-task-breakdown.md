# Plan: Linked State Phase 0-1 Task Breakdown

> Source plan: `doc/plans/2026-04-06-linked-state-adoption-and-runtime-unification-plan.md`

## Goal

Break Phases 0 and 1 into implementation-ready vertical slices with exact touchpoints so we can start building without re-deciding structure during execution.

This breakdown only covers:

- Phase 0: local state discovery
- Phase 1: linked source registry and onboarding

## Durable Implementation Decision

The linked-source registry should live in host-local `config.json`, not in `instance_settings`.

Why:

- it is machine-specific, not company/business state
- it must be available before the server DB/UI is useful
- it should follow the same locality rules as other path-based runtime configuration
- the CLI must be able to create and repair it even when the DB is unavailable

The DB-backed `instance_settings` table can still store UI preferences and toggles, but not canonical adopted-home paths.

---

## Slice 1: Add Runtime Sources to Config Schema

**Type**: AFK  
**Blocked by**: None

### What to build

Extend the Paperclip config schema to support a host-local linked-source registry for:

- Paperclip instance roots
- Codex home
- OpenClaw home

Define the source modes and status metadata shape that later slices will read and write.

### Exact touchpoints

- [packages/shared/src/config-schema.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/packages/shared/src/config-schema.ts)
  Add a `runtimeSources` section and exported types.
- [packages/shared/src/index.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/packages/shared/src/index.ts)
  Re-export the new config schema/types.
- [cli/src/config/store.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/cli/src/config/store.ts)
  Ensure read/write/migration paths preserve the new section.
- [cli/src/config/schema.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/cli/src/config/schema.ts)
  Re-export remains aligned automatically once shared schema changes.
- [server/src/config-file.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/server/src/config-file.ts)
  Validate the new config shape on the server side.
- [server/src/config.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/server/src/config.ts)
  Read the new config section into the runtime config object where needed.

### Acceptance criteria

- [ ] `config.json` supports a `runtimeSources` section with linked/shared and managed modes.
- [ ] CLI config read/write continues to work with and without `runtimeSources`.
- [ ] Server config loading continues to parse valid configs after the schema change.
- [ ] Invalid runtime-source config values fail fast with useful validation output.

---

## Slice 2: Build Shared Local State Discovery Engine

**Type**: AFK  
**Blocked by**: Slice 1

### What to build

Create a reusable discovery engine that detects local Paperclip, Codex, and OpenClaw homes and reports inexpensive health and inventory hints.

The engine should not mutate anything. It should be callable from both CLI and server routes.

### Exact touchpoints

- New shared implementation module, likely under:
  - `cli/src/config/` if CLI-local first, then extracted if needed
  - or a new shared utility module if both CLI and server need the same logic immediately
- [cli/src/config/home.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/cli/src/config/home.ts)
  Reuse home/path helpers for Paperclip defaults.
- [server/src/home-paths.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/server/src/home-paths.ts)
  Reuse server-side home expansion and default path logic.
- [packages/adapters/codex-local/src/server/codex-home.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/packages/adapters/codex-local/src/server/codex-home.ts)
  Reuse existing Codex home resolution rules instead of inventing new ones.

Suggested outputs for the discovery engine:

- detected path
- source kind
- availability status
- readability/health warning if any
- cheap inventory summary such as:
  - Paperclip instance present
  - Codex thread/session index present
  - Codex plugin/cache presence
  - OpenClaw session index present
  - OpenClaw memory DB present
  - OpenClaw skills presence

### Acceptance criteria

- [ ] Discovery can find the default local homes on macOS.
- [ ] Discovery returns `available`, `missing`, or `error` per source.
- [ ] Discovery performs only read-only checks.
- [ ] Discovery surfaces counts or presence hints without deep expensive indexing.

---

## Slice 3: Add CLI Runtime Source Commands

**Type**: AFK  
**Blocked by**: Slice 1, Slice 2

### What to build

Add a dedicated CLI command group for runtime-source discovery and linking instead of hiding this behind ad hoc prompts.

Recommended command group:

- `paperclipai sources detect`
- `paperclipai sources show`
- `paperclipai sources link`

Then teach onboarding to call into this flow when linked sources are not configured yet.

### Exact touchpoints

- New command module, for example:
  - `cli/src/commands/runtime-sources.ts`
  - or `cli/src/commands/sources.ts`
- [cli/src/index.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/cli/src/index.ts)
  Register the new command group.
- [cli/src/commands/onboard.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/cli/src/commands/onboard.ts)
  Integrate the linked-source onboarding step into first-run setup.
- [cli/src/commands/run.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/cli/src/commands/run.ts)
  Preserve current behavior but make missing/adoption state easier to diagnose.
- [cli/src/commands/doctor.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/cli/src/commands/doctor.ts)
  Add a linked-source check or warning.
- New CLI checks module, likely:
  - `cli/src/checks/runtime-sources-check.ts`

### Acceptance criteria

- [ ] CLI can print detected local sources without changing config.
- [ ] CLI can persist linked-source selections into `config.json`.
- [ ] CLI can show the current linked-source configuration.
- [ ] `paperclipai onboard` can guide a new local user through linking sources.
- [ ] `paperclipai doctor` warns clearly when linked-source config is missing or broken.

---

## Slice 4: Add Server Runtime Source Read/Write and Discovery APIs

**Type**: AFK  
**Blocked by**: Slice 1, Slice 2

### What to build

Expose runtime-source configuration and discovery over authenticated Paperclip APIs so the UI can render and update the same host-local linked-source state.

Keep this config-file-backed, not DB-backed.

Recommended API surface:

- `GET /api/instance/runtime-sources`
- `PATCH /api/instance/runtime-sources`
- `POST /api/instance/runtime-sources/discover` or `GET /api/instance/runtime-sources/discovery`

### Exact touchpoints

- New route module:
  - `server/src/routes/instance-runtime-sources.ts`
- New service or helper module:
  - `server/src/services/runtime-sources.ts`
  - or `server/src/services/runtime-source-discovery.ts`
- [server/src/app.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/server/src/app.ts)
  Mount the new routes.
- [server/src/config-file.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/server/src/config-file.ts)
  Add write/update support or pair with a new config-file writer.
- [server/src/routes/health.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/server/src/routes/health.ts)
  Optionally add a simple `runtimeSourcesConfigured` or `runtimeSourcesHealth` summary for startup UX.
- [packages/shared/src](/Users/amartyasingh/Documents/projects/paperclip-ai/packages/shared/src)
  Add shared request/response types and validators for the new API surface.

### Acceptance criteria

- [ ] Authenticated board users can read the current runtime-source config through the server API.
- [ ] Instance-admin-capable users can update runtime-source config through the server API.
- [ ] The server API can return fresh discovery results from the local machine.
- [ ] The server writes the linked-source registry back to host-local `config.json`.
- [ ] The API clearly distinguishes persisted config from fresh discovery results.

---

## Slice 5: Add UI Runtime Sources Settings Page

**Type**: AFK  
**Blocked by**: Slice 4

### What to build

Add a dedicated UI surface for local runtime-source adoption so users do not need the CLI if they prefer not to use it.

This page should let users:

- see current linked/shared vs managed/copy modes
- run discovery
- choose detected sources
- save the runtime-source config
- understand which skills/plugins were found in each adopted runtime home

### Exact touchpoints

- New API client module:
  - `ui/src/api/runtimeSources.ts`
- New page:
  - `ui/src/pages/InstanceRuntimeSourcesSettings.tsx`
- [ui/src/App.tsx](/Users/amartyasingh/Documents/projects/paperclip-ai/ui/src/App.tsx)
  Add the route under instance settings.
- [ui/src/pages/InstanceSettings.tsx](/Users/amartyasingh/Documents/projects/paperclip-ai/ui/src/pages/InstanceSettings.tsx)
  Add navigation entry to the new settings surface.
- [ui/src/lib/instance-settings.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/ui/src/lib/instance-settings.ts)
  Add the route to remembered instance-settings path normalization.
- [ui/src/api/instanceSettings.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/ui/src/api/instanceSettings.ts)
  Keep separate from runtime-source API; do not overload instance settings endpoints.

### Acceptance criteria

- [ ] The UI can display current runtime-source config.
- [ ] The UI can run discovery and show the results.
- [ ] The UI can save linked/shared and managed/copy selections.
- [ ] The UI clearly labels source mode and canonical-home behavior.
- [ ] The page works without requiring company selection because this is instance-local configuration.

---

## Slice 6: Wire Linked-Source Adoption Into Onboarding and Empty States

**Type**: HITL  
**Blocked by**: Slice 3, Slice 5

### Why HITL

This slice changes first-run experience and language. The copy and flow should be reviewed because it affects the mental model of the whole product.

### What to build

Integrate runtime-source adoption into onboarding so a new install on a machine with existing local state does not feel empty or misleading.

For the first UI pass, do not redesign all onboarding. Add one narrow pre-step or callout:

- "We found existing local agent state on this machine."
- "Link it now" vs "Skip for now"

### Exact touchpoints

- [ui/src/components/OnboardingWizard.tsx](/Users/amartyasingh/Documents/projects/paperclip-ai/ui/src/components/OnboardingWizard.tsx)
  Add a linked-state adoption pre-step or entry point.
- [ui/src/App.tsx](/Users/amartyasingh/Documents/projects/paperclip-ai/ui/src/App.tsx)
  Keep onboarding route behavior aligned with the new adoption flow.
- [cli/src/commands/onboard.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/cli/src/commands/onboard.ts)
  Keep CLI onboarding language aligned with the UI.
- [cli/src/commands/run.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/cli/src/commands/run.ts)
  Improve the "no config / start onboarding" messaging if runtime sources are detected.
- [server/src/routes/health.ts](/Users/amartyasingh/Documents/projects/paperclip-ai/server/src/routes/health.ts)
  Optional startup hint for "instance configured but no runtime sources linked yet".

### Acceptance criteria

- [ ] First-run onboarding can offer linked-state adoption when local state exists.
- [ ] Users can skip adoption and continue onboarding.
- [ ] The language clearly explains that linked mode keeps the native runtime homes canonical.
- [ ] CLI and UI onboarding use consistent terminology.
- [ ] The empty-state/first-run experience no longer implies that the user's machine is starting from scratch when local state already exists.

---

## Recommended Execution Order

1. Slice 1
2. Slice 2
3. Slice 3
4. Slice 4
5. Slice 5
6. Slice 6

## Recommended First Commit Sequence

If we want this to stay low-risk, the first few commits should roughly be:

1. Config schema + types
2. Discovery engine + tests
3. CLI detect/show/link commands
4. Server runtime-source API
5. UI runtime-source settings page
6. Onboarding integration

## What We Explicitly Are Not Doing Yet

- We are not indexing actual Codex threads yet.
- We are not indexing actual OpenClaw sessions yet.
- We are not adding Codex app-server integration yet.
- We are not changing conversation/run models yet.
- We are not building mobile UI yet.

That comes after linked-source adoption is in place.

## Skills and Plugins Note

Skills and plugins are not a separate migration project.

For Phases 0 and 1 they should be treated as inventory and linkage concerns:

- detect them
- report them
- keep their native homes canonical

Only later should we decide whether Paperclip needs richer management UIs for linked runtime skills or plugins.
