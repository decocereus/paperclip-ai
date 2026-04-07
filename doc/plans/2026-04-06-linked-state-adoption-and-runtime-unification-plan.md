# Plan: Linked State Adoption and Runtime Unification

> Source architecture: `doc/plans/2026-04-06-paperclip-codex-openclaw-control-plane.md`

## Purpose

Turn Paperclip into the control plane for the agent state that already exists on a user's machine:

- existing Paperclip instance data in `~/.paperclip`
- existing Codex threads and config in `~/.codex`
- existing Codex plugin state in `~/.codex/plugins`
- existing OpenClaw sessions, skills, and memory in `~/.openclaw`

The plan is intentionally ordered so we do not build a polished empty shell first. The first priority is making the running local state visible and controllable from one place without duplicating it.

## Durable Decisions

These decisions should hold across all phases unless we discover a hard blocker.

- **Linked local state is the default**: For personal local installs, Paperclip should point at the user's existing `~/.paperclip`, `~/.codex`, and `~/.openclaw` state instead of copying it into fresh stores.
- **Managed copies are opt-in**: Isolated per-company or per-instance copies stay supported, but only when the user explicitly chooses isolation.
- **Paperclip remains the system of record for control-plane workflow**: Companies, agents, issues, approvals, budgets, and operator actions stay in Paperclip even when runtime state lives in Codex or OpenClaw homes.
- **Conversations remain issue-backed**: Paperclip should not create a second free-floating chat domain. Every durable conversation is anchored to an issue or issue-like work object.
- **Runtime sessions stay canonical in their native homes**: Codex threads remain canonical in the Codex home. OpenClaw sessions and memory remain canonical in the OpenClaw home.
- **Runtime skills and plugins stay canonical in their native homes**: Codex and OpenClaw skills/plugins should be linked and indexed, not silently re-homed by default.
- **Paperclip indexes and links, it does not silently import everything**: Paperclip should materialize metadata and references into its own DB, but the authoritative session payloads stay in the native runtime stores.
- **Clients speak to Paperclip, not directly to runtime protocols**: Web and mobile should talk to Paperclip APIs and live-event streams. Only the server talks JSON-RPC to Codex app-server or gateway RPC to OpenClaw.
- **Onboarding is local-machine only for now**: Detection and adoption of local state happens on the laptop or machine that owns those directories. Mobile can supervise later, but it does not own onboarding yet.
- **CLI-first onboarding is acceptable**: A CLI flow can arrive before the UI wizard, as long as the UI eventually exposes the same capabilities.
- **Memory is provider-linked first**: OpenClaw memory should initially appear in Paperclip as a linked memory provider/store, not as copied rows inside Paperclip Postgres.

## Progress Update (2026-04-07)

This is the current implementation snapshot after the first major build-out.

### Landed

- Linked runtime-source config now exists and is persisted through Paperclip host-local config.
- Paperclip can discover and link existing `~/.paperclip`, `~/.codex`, and `~/.openclaw` homes.
- CLI support exists for runtime-source detection, inspection, linking, onboarding, and doctor checks.
- Runtime Sources now has server APIs and a working web settings page.
- Existing Codex threads, Codex skills/plugins, OpenClaw sessions, and OpenClaw skills can be indexed and shown in Paperclip.
- Issues can now link to external Codex threads or OpenClaw sessions.
- Paperclip now exposes issue conversation read, send, steer, interrupt, and approval-resolution APIs for linked conversations.
- Linked Codex conversations can use a live `codex app-server` manager for interactive supervision.
- Linked Codex approvals are brokered into the Paperclip approval model.
- OpenClaw linked sessions now participate in session reuse through task-session state.
- Shared Codex-home mode is wired into `codex_local`, so linked sessions can continue against the canonical shared Codex home.
- Issue creation can now attach a repo, load repo-related Codex threads, and either continue one or start a new shared Codex thread.
- Onboarding now supports an optional local repo attachment for the initial project/issue path.
- Repo attachment now persists through issue runtime-link metadata and survives reloads/server restarts.
- The issue detail external-conversation UI has been tightened and made more repo-aware.

### Partially Landed

- OpenClaw has linked preview and session reuse, but it does not yet have full live-manager parity with the Codex interactive path.
- Repo attachment is now a first-class issue/onboarding flow, but there is still room to make project/workspace selection more elegant and more obvious in the UX.
- Codex live supervision works in the current server process, but some transient live state is still more restart-sensitive than ideal.

### Not Done Yet

- Full durable restart-safe persistence for every live Codex approval/session-control edge case.
- True OpenClaw live conversation manager parity with send/stream/interrupt handling comparable to Codex.
- Mobile supervision client on top of the shared conversation API.
- Final polish pass on onboarding and issue creation UX for repo attachment and linked-runtime terminology.

### Recommended Next Steps

1. Finish OpenClaw live-manager parity so linked OpenClaw sessions support the same operator-level supervision model as Codex where the runtime allows it.
2. Harden Codex live runtime durability so approval/session state survives server restarts more cleanly.
3. Add focused end-to-end tests for the new repo-attached issue creation path and shared-thread continuity.
4. Polish onboarding and issue creation UX copy so repo attachment and linked/shared behavior are more self-explanatory.
5. Build the first mobile supervision surface on top of the existing Paperclip conversation APIs.

## Phase 0: Local State Discovery

**User stories**:

- As a local user, I want Paperclip to detect my existing Paperclip, Codex, and OpenClaw homes.
- As a local user, I want a clear summary of what Paperclip found before anything is linked or indexed.
- As a local user, I want the same discovery flow to be accessible from CLI first and UI later.

### What to build

Add a local discovery service that scans for existing runtime homes and reports what is available. Start with a CLI command, then expose the same discovery output through a server endpoint so the UI can render it.

The discovery surface should report:

- detected Paperclip instance roots
- detected Codex home path
- detected OpenClaw home path
- whether each source appears readable and healthy
- counts or presence hints for companies, threads, sessions, memory DBs, skills, and plugins where inexpensive to compute

### Acceptance criteria

- [ ] A CLI command can detect the current machine's local `paperclip`, `codex`, and `openclaw` homes.
- [ ] Discovery output distinguishes `available`, `missing`, and `error` states.
- [ ] Discovery does not mutate any runtime state.
- [ ] Discovery results are available through a server API that the UI can later consume.

---

## Phase 1: Linked Source Registry and Onboarding

**User stories**:

- As a local user, I want to tell Paperclip which local homes to adopt.
- As a local user, I want to choose linked mode by default and managed-copy mode only when I explicitly need it.
- As a local user, I want onboarding to be simple enough that I can complete it from a terminal in a few steps.
- As a local user, I want runtime skills and plugins to be treated as part of the adopted local state.

### What to build

Add a persisted source-registry/config layer inside Paperclip that records which external homes are adopted and how.

It should support at least:

- shared Paperclip instance
- shared Codex home
- shared OpenClaw home
- optional managed-copy mode for Codex and OpenClaw later

This phase should also define the onboarding flow:

- CLI flow first
- server-backed UI flow second

### Acceptance criteria

- [ ] Paperclip can persist the selected local source paths and their adoption mode.
- [ ] The default personal-local flow chooses linked/shared mode for Codex and OpenClaw.
- [ ] Users can explicitly opt into managed-copy mode instead of linked mode.
- [ ] The onboarding flow is local-machine only and explains that clearly.
- [ ] Paperclip can reconnect to the same adopted sources after restart.

---

## Phase 2: Codex Shared-Home Adoption

**User stories**:

- As a Codex-heavy user, I want my existing Codex threads to be visible inside Paperclip.
- As a Codex-heavy user, I want a Paperclip-linked thread to remain visible in other Codex surfaces like the Codex Mac app.
- As a Codex-heavy user, I do not want Paperclip to create a separate hidden universe of copied Codex state by default.
- As a Codex-heavy user, I want existing Codex plugins/extensions to remain usable because the canonical Codex home remains shared.

### What to build

Teach Paperclip to use a shared Codex home directly instead of always seeding a per-company managed home.

Add a Codex thread indexer that:

- reads existing thread/session metadata from the shared home
- creates Paperclip metadata records or links for discovered threads
- allows a Paperclip issue conversation to attach to an existing Codex thread

This phase is about adoption and indexing, not yet the richer app-server interaction loop.

### Acceptance criteria

- [ ] Paperclip supports a `shared` Codex home mode in addition to the existing managed home behavior.
- [ ] Existing Codex threads from the shared home can be discovered and listed in Paperclip metadata.
- [ ] Paperclip stores links to Codex thread ids without copying rollout files by default.
- [ ] A linked Codex thread remains usable from native Codex surfaces because the canonical state stays in the shared home.
- [ ] Codex plugin/cache presence can be discovered and reported as part of shared-home adoption.
- [ ] Managed-home mode still works when explicitly selected.

---

## Phase 3: OpenClaw Shared-Home Adoption

**User stories**:

- As an OpenClaw user, I want my existing OpenClaw sessions to be visible and resumable from Paperclip.
- As an OpenClaw user, I want my OpenClaw session to remain usable from native OpenClaw surfaces.
- As an OpenClaw user, I want OpenClaw memory to remain canonical in the OpenClaw home while still being known to Paperclip.
- As an OpenClaw user, I want my existing OpenClaw skills to be recognized as part of the adopted runtime state.

### What to build

Add OpenClaw source adoption and indexing:

- discover sessions from the OpenClaw session index and agent session files
- create Paperclip metadata records or links for those sessions
- expose the presence of OpenClaw memory as a linked memory source/provider

Do not copy the OpenClaw memory SQLite DB into Paperclip core in this phase.

### Acceptance criteria

- [ ] Existing OpenClaw sessions can be discovered from the adopted OpenClaw home.
- [ ] Paperclip can store stable links to OpenClaw session ids and file references.
- [ ] A linked OpenClaw session remains usable from native OpenClaw surfaces because the canonical state stays in the OpenClaw home.
- [ ] OpenClaw memory is registered in Paperclip as a linked external memory source, not copied into Paperclip core.
- [ ] OpenClaw skills presence can be discovered and reported as part of shared-home adoption.
- [ ] Discovery and linking handle missing or partially corrupted OpenClaw state gracefully.

---

## Phase 4: Conversation Link Model

**User stories**:

- As a Paperclip user, I want an issue to link to an adopted Codex thread or OpenClaw session.
- As a Paperclip user, I want Paperclip to know whether a conversation is linked, unlinked, or needs me to choose a source.
- As a Paperclip user, I want session continuity across surfaces without losing Paperclip's issue-backed workflow model.

### What to build

Add the minimal server-side model needed to attach a Paperclip issue conversation to an external runtime conversation.

This phase should define:

- how an issue links to a Codex thread or OpenClaw session
- how those links are stored and updated
- how `agent_task_sessions` participates in resumption without pretending it owns the canonical runtime payload

### Acceptance criteria

- [ ] A Paperclip issue can be linked to an adopted Codex thread or OpenClaw session.
- [ ] Paperclip can display the current link state for a conversation.
- [ ] `agent_task_sessions` or a companion metadata model can persist stable external session references.
- [ ] Linking and unlinking are explicit operator actions.
- [ ] Issue-backed conversation identity remains the Paperclip control-plane anchor.

---

## Phase 5: Operator Conversation API

**User stories**:

- As a web or mobile client, I want one Paperclip API for conversation reads and writes regardless of runtime.
- As a board operator, I want Paperclip to hide the runtime-specific protocol details.
- As a developer, I want a stable API contract that supports web and mobile without each client reimplementing runtime logic.

### What to build

Add a Paperclip-owned conversation API for issue-backed runtime interactions.

This should include:

- conversation read
- send
- steer
- interrupt
- event history
- live event streaming through the existing company-scoped websocket channel

This API should work for linked sessions even before the full interactive UI is polished.

### Acceptance criteria

- [ ] Paperclip exposes a conversation read surface for issue-backed conversations.
- [ ] Paperclip exposes `send`, `steer`, and `interrupt` actions through its own API.
- [ ] The same API contract can back both web and mobile clients.
- [ ] Runtime-specific protocol details remain server-side.
- [ ] Existing live-event infrastructure can carry run and transcript updates for conversation UIs.

---

## Phase 6: Codex App-Server Interactive Runtime

**User stories**:

- As a Codex user, I want to send messages, steer, and interrupt from Paperclip while still using the same underlying Codex thread I use elsewhere.
- As a board operator, I want to see live Codex agent events in Paperclip.
- As a board operator, I want Paperclip to broker Codex approvals.

### What to build

Add a new Codex interactive runtime bridge backed by `codex app-server`.

The bridge should map:

- Paperclip issue conversation -> Codex thread
- send -> `turn/start`
- steer -> `turn/steer`
- interrupt -> `turn/interrupt`
- streamed items -> Paperclip transcript and event model
- approvals -> Paperclip operator approval flow

This should be delivered as a new runtime path rather than a risky in-place replacement for the current batch-style `codex_local` flow.

### Acceptance criteria

- [ ] Paperclip can talk to Codex through `codex app-server` using linked shared-home state.
- [ ] A Paperclip-linked Codex conversation resumes the same underlying thread visible in native Codex surfaces.
- [ ] Paperclip can send, steer, and interrupt a Codex run through its own API.
- [ ] Codex streamed items appear in Paperclip transcript/event UIs.
- [ ] Codex approval prompts are surfaced and resolved through Paperclip.

---

## Phase 7: OpenClaw Interactive Runtime Tightening

**User stories**:

- As an OpenClaw user, I want the same Paperclip operator surface to work for OpenClaw-backed conversations.
- As a board operator, I want OpenClaw runs to look consistent with Codex runs in Paperclip without faking identical semantics.
- As a board operator, I want Paperclip to supervise OpenClaw sessions without owning the canonical session payload.

### What to build

Tighten the existing OpenClaw gateway integration so it conforms to the same operator conversation model as Codex where possible.

This includes:

- standard event normalization
- better session metadata persistence
- stop/interrupt semantics where supported
- conversation linking to adopted OpenClaw sessions

### Acceptance criteria

- [ ] OpenClaw-backed issue conversations use the same Paperclip conversation API as Codex-backed ones.
- [ ] OpenClaw session links remain canonical in the OpenClaw home.
- [ ] OpenClaw run events are normalized enough to render in the same operator UI patterns as Codex.
- [ ] Paperclip can supervise and interrupt OpenClaw runs where the runtime supports it.
- [ ] Runtime-specific differences are preserved rather than flattened away.

---

## Phase 8: CLI and UI Onboarding Polish

**User stories**:

- As a local user, I want a very simple onboarding flow that helps me adopt my existing state.
- As a non-CLI user, I want the same adoption flow available in the web UI.
- As a user, I want clear feedback when something is linked vs copied.

### What to build

Finish the onboarding experience:

- production-worthy CLI flow
- matching web UI flow
- clear language around linked/shared vs managed/copy modes
- validation and health checks for local source homes

### Acceptance criteria

- [ ] A user can complete the linked-state onboarding from CLI without reading code.
- [ ] A user can complete the same flow from the web UI.
- [ ] The UI clearly shows whether a runtime source is linked/shared or managed/copied.
- [ ] Onboarding explains that adoption must happen on the machine that owns the local state.
- [ ] Health checks catch missing binaries, unreadable directories, and invalid source paths before runtime use.

---

## Phase 9: Mobile Supervision Surface

**User stories**:

- As a mobile user, I want to monitor active agent runs.
- As a mobile user, I want to approve, interrupt, and re-task a conversation from my phone.
- As a mobile user, I want that supervision to work against the same linked runtime state as desktop Paperclip.

### What to build

Build a mobile supervision client against the already-established Paperclip conversation API and live-event channel.

This phase should stay intentionally narrow:

- active runs
- approvals
- conversation view
- send / steer / interrupt

Desktop/local onboarding remains out of scope for mobile in this phase.

### Acceptance criteria

- [ ] Mobile uses the same Paperclip conversation API as web.
- [ ] Mobile can monitor active conversations and runs in real time.
- [ ] Mobile can approve, interrupt, and send follow-up guidance.
- [ ] No mobile-specific runtime protocol logic is required.
- [ ] Linked runtime state remains canonical in the native homes.

## Recommended Build Order

If we execute this as tracer bullets, the order should be:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7
9. Phase 8
10. Phase 9

This order intentionally front-loads adoption of real local state before interactive runtime work, because that is what makes the system immediately useful on a machine like yours.

## First Three Demo Milestones

These are the first three checkpoints we should aim to demo.

### Demo 1: Discovery and linking

- Paperclip detects `~/.paperclip`, `~/.codex`, and `~/.openclaw`
- user links those sources
- Paperclip persists the linked-source config

### Demo 2: Existing conversations visible

- existing Codex threads appear in Paperclip
- existing OpenClaw sessions appear in Paperclip
- no runtime state is copied by default

### Demo 3: One linked Codex conversation fully supervised from Paperclip

- open linked issue conversation
- send
- stream
- interrupt
- resolve approval
- confirm the same thread is still visible in native Codex

## Risks to Track Throughout

- Shared-home support can expose assumptions in current per-company managed-home code paths.
- Linked-state indexing can get expensive if discovery becomes too deep or too eager.
- Codex approval brokering is likely the hardest interactive runtime piece.
- OpenClaw memory should remain linked first or we risk building a fragile one-off importer too early.
- UI copy has to make linked vs managed state very obvious or users will not trust what is happening.
