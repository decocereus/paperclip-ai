# Paperclip + Codex App Server + OpenClaw Control Plane

## Context

The goal is not to mash three products together at random.

The goal is to make Paperclip genuinely useful as the control plane for day-to-day agent work by combining:

- Paperclip as the system of record for companies, agents, issues, runs, approvals, costs, and operator visibility
- Codex app-server as the deep interactive runtime for Codex-backed agents
- OpenClaw as another first-class runtime that can already execute durable, session-aware agent loops

The important constraint from the current Paperclip product definition is that the system should stay issue/task-centric, not become a generic chat app. The existing plan in `doc/plans/2026-03-11-agent-chat-ui-and-issue-backed-conversations.md` is directionally correct and should be treated as the product foundation for this effort.

## Concrete User Flows We Actually Need

Start from concrete behavior, not architecture:

1. I open an issue in Paperclip and talk to an agent in a chat-like UI.
2. That agent may be backed by Codex or OpenClaw.
3. I can watch the run live: assistant text, tool calls, command output, file changes, lifecycle events.
4. I can interrupt, steer, or re-task the agent while it is running.
5. If the runtime needs approval, I can approve or reject it from the same operator surface.
6. When I come back later, the conversation is still there and still tied to the issue, cost trail, artifacts, and org context.
7. The same core operator experience works on web and mobile because both clients talk to the same API and live event stream.

If we deliver those seven things, the integration is useful.

## Recommendation

Do not try to make OpenClaw secretly run Codex or make Codex secretly run OpenClaw.

That will create a hard-to-debug stack of nested runtimes and muddy the operator model.

Instead:

- keep Paperclip as the control plane
- keep Codex app-server as the native runtime for Codex agents
- keep OpenClaw as the native runtime for OpenClaw agents
- add one normalized operator/session layer in Paperclip so both runtimes feel consistent to the board

In other words:

Paperclip should supervise heterogeneous agent runtimes, not erase their differences.

## Current Repo Reality

The codebase already gives us a lot:

- `codex_local` exists today, but it currently shells out to `codex exec --json`, not `codex app-server`
- `openclaw_gateway` already exists and already uses an issue-friendly session key strategy
- `agent_task_sessions` already persists session params per agent + adapter + task key
- `heartbeat_runs` and `heartbeat_run_events` already model durable runs and streamed events
- live operator updates already flow over company-scoped WebSocket events
- the UI already has transcript parsing and live run rendering patterns

That means this project should be an evolution of existing Paperclip primitives, not a greenfield subsystem.

## Existing Local State Must Be Adopted

This project also needs an explicit "adopt existing local state" story.

In a real personal setup, there are already three homes:

- Paperclip state in `~/.paperclip`
- Codex state in `~/.codex`
- OpenClaw state in `~/.openclaw`

The integration will feel broken if Paperclip starts a fresh empty universe and ignores those homes.

### Important rule

Do not default to copying everything into new Paperclip-owned stores.

That creates divergence:

- Codex threads split between the real `~/.codex` home and Paperclip-managed per-company homes
- OpenClaw sessions and memory split between gateway-owned state and imported Paperclip shadows
- user confusion about which system is now canonical

The better default is:

- adopt existing state as the source of truth
- index it into Paperclip
- let Paperclip control and supervise it
- only add snapshot/copy modes when the user explicitly wants isolation

## Adopt vs Copy

Every external runtime should support two modes:

### 1. Linked / adopted mode

Paperclip points at the user's existing home directory and treats it as the canonical runtime state.

Use this by default for personal local installs.

### 2. Managed / copied mode

Paperclip copies or seeds a runtime-specific home under the active instance and owns the resulting state.

Use this when the user wants:

- company isolation
- reproducible packaged environments
- safer testing
- multi-company separation on one machine

For your setup, linked / adopted mode is the right default.

## Product Shape

### Primary rule

Every durable conversation remains issue-backed.

That means:

- the issue is the durable work object
- the assigned agent runtime owns the conversation session
- each user send creates or steers a run on that issue
- all cost, approvals, activity, and output remain attached to the issue

This keeps Paperclip aligned with its V1 contract while still feeling conversational.

### Operator mental model

The board should not need to think about `thread`, `turn`, `runId`, `sessionKey`, or `agent.wait` most of the time.

The board should think:

- this issue has an active conversation
- this agent is running
- here is what it is doing
- here is what needs my decision
- here is how I stop or redirect it

## Core Architecture

## 1. Paperclip stays the system of record

Paperclip should remain authoritative for:

- companies
- agents and org structure
- issues/comments/projects/goals
- run history
- approvals and operator actions
- costs and budget enforcement
- live operator event fanout

Neither Codex app-server nor OpenClaw should become the source of truth for board-facing workflow state.

## 2. Add a normalized conversation/runtime bridge in Paperclip

Paperclip needs one internal abstraction that sits between operator UX and agent runtimes.

Suggested shape:

- `ConversationSession`
  - durable identity: company + agent + issue
  - backed by `agent_task_sessions`
- `InteractionRun`
  - one user request / one active runtime execution
  - backed by `heartbeat_runs`
- `InteractionEvent`
  - assistant delta, tool call, command output, lifecycle, approval request
  - backed by `heartbeat_run_events` plus live websocket events
- `InteractionAction`
  - send
  - steer
  - interrupt
  - approve / reject

This does not have to become a giant generic SDK. It just needs to be a thin normalization layer so Codex and OpenClaw can plug into the same operator surface.

## 2.5 Add an external state adoption layer

Paperclip needs one explicit service that discovers and adopts pre-existing runtime state from the local machine.

Suggested shape:

- `ExternalStateSource`
  - `kind`: `paperclip_instance | codex_home | openclaw_home`
  - `path`
  - `mode`: `linked | managed_copy`
  - `status`: `available | missing | error`
- `ExternalStateInventory`
  - conversations / threads / sessions
  - memory stores
  - skills/config/auth artifacts
  - plugin homes / plugin cache state / installed extensions
  - routines / cron jobs where relevant

This can start as a server-side discovery/import service and later get a UI wizard.

## 3. Add a new Codex runtime bridge based on app-server

This is the biggest missing piece.

Paperclip should add a new Codex integration that talks to `codex app-server` over JSON-RPC and maps:

- Codex `thread` -> Paperclip issue conversation session
- Codex `turn` -> Paperclip interaction run
- Codex `item/*` notifications -> Paperclip interaction events / transcript entries
- Codex approval requests -> Paperclip operator approval requests
- `turn/steer` -> Paperclip “jump in”
- `turn/interrupt` -> Paperclip “stop”

Recommendation:

- do not replace `codex_local` immediately
- add a parallel adapter/runtime, likely `codex_appserver` or `codex_interactive`
- keep `codex_local` for simple batch heartbeat execution until the new path is proven

Why parallel first:

- lower migration risk
- easier A/B comparison
- preserves the current reliable fallback path

### Codex state adoption

Codex already has durable local conversation state in its home directory.

Relevant state includes:

- thread/session index files
- rollout JSONL transcripts
- local SQLite state/log databases
- auth/config/model metadata
- plugins and plugin cache state

Paperclip should support:

- `codexHomeMode = shared | managed`
- `shared` points directly at the user's existing Codex home and should be the personal-install default
- `managed` keeps the current Paperclip-owned per-company home behavior for isolation scenarios

Paperclip should also add a Codex thread importer/indexer:

- in `shared` mode, enumerate existing threads from the shared home using Codex APIs when possible
- create or update Paperclip metadata records that let those threads appear in the control plane
- do not copy rollout files unless the user explicitly requests snapshot import

This is the key product fix for "all my existing Codex threads should show up in Paperclip."

## 4. Keep OpenClaw native and issue-scoped

OpenClaw should remain a first-class runtime, not a temporary compatibility layer.

Paperclip should continue using `openclaw_gateway`, but tighten the bridge:

- persist richer session metadata in `agent_task_sessions.sessionParamsJson`
- standardize run summaries and usage extraction
- map gateway event streams into the same normalized transcript model used by Codex
- ensure `interrupt` maps cleanly to the relevant OpenClaw stop/cancel semantics when exposed

OpenClaw already naturally fits an issue-backed session model because its gateway flow already centers on `agent`, `agent.wait`, lifecycle events, and serialized per-session execution.

### OpenClaw state adoption

OpenClaw already has explicit local stores for:

- session index/state
- session JSONL transcripts
- memory database(s)
- skills/config/auth profiles
- plugin-like extension/config state where applicable
- cron jobs and run logs

Paperclip should support:

- linking to an existing OpenClaw home path
- indexing existing OpenClaw sessions into Paperclip conversation metadata
- preserving session file references so Paperclip can reopen, supervise, and continue them

For memory specifically:

- do not first copy OpenClaw's memory database into Paperclip's primary DB
- instead, treat OpenClaw memory as an external memory provider/store that Paperclip knows exists
- optionally add search/inspect tools later, but keep the original memory store canonical

This is enough to satisfy "use it from one control plane" without building a lossy ETL pipeline on day one.

### Skills and plugins adoption

Skills and plugins should follow the same linked-state rule as conversations:

- if a runtime already has a native skill directory, Paperclip should detect and reference it
- if a runtime already has plugin or extension state, Paperclip should detect and report it
- Paperclip may choose to mirror metadata for UX, but it should not silently fork the canonical runtime directories

For your current setup this likely means:

- Codex skills remain anchored in the effective Codex home
- Codex plugin/cache state remains anchored in `~/.codex/plugins`
- OpenClaw skills remain anchored in `~/.openclaw/skills`
- Paperclip surfaces those assets as linked runtime capabilities

## Runtime Mapping

## Codex app-server mapping

Recommended mapping:

- Paperclip issue conversation key -> Codex thread id
- Paperclip send message -> `turn/start`
- Paperclip steer active run -> `turn/steer`
- Paperclip stop run -> `turn/interrupt`
- Paperclip review action later -> `review/start`
- Codex `item/agentMessage/delta` -> assistant transcript delta
- Codex tool/command/file items -> transcript and structured event rows
- Codex approval requests -> Paperclip approval inbox item + run-scoped prompt

One important design choice:

The long-lived `codex app-server` process should be treated as a runtime service, not as the run itself.

That means:

- Paperclip may keep one managed app-server process per company, or per reusable workspace/runtime scope
- each operator request still creates a normal `heartbeat_runs` row
- the run row stores the linked Codex thread/turn identity in existing metadata fields

That preserves Paperclip’s accounting and audit model while still unlocking Codex’s richer session protocol.

## OpenClaw mapping

Recommended mapping:

- Paperclip issue conversation key -> OpenClaw `sessionKey`
- Paperclip run id -> OpenClaw `runId` in `external_run_id`
- OpenClaw assistant/tool/lifecycle streams -> normalized transcript events
- OpenClaw wait completion -> run completion

This is already close to today’s adapter behavior and should be refined, not reinvented.

## Data Model Direction

The best near-term move is to avoid introducing a separate `conversations` table.

Use the existing shape:

- issue is the durable conversation anchor
- `agent_task_sessions` stores runtime session params
- `heartbeat_runs` stores each interaction attempt
- `heartbeat_run_events` stores normalized event stream

Small additive fields may still be useful later, but the first version should try hard to fit the existing model.

What is still likely needed:

- a small external-source registry table or config surface
- imported conversation link records so Paperclip can attach an issue to an adopted Codex thread or OpenClaw session
- optional sync metadata such as last indexed timestamp, source home path, and source ids

## API Direction

Build an explicit operator conversation API instead of leaking runtime-specific protocols to clients.

Suggested server API shape:

- `GET /issues/:id/conversation`
  - returns issue-backed message history + active session info
- `POST /issues/:id/conversation/send`
  - send a new user message and create a run
- `POST /issues/:id/conversation/steer`
  - steer the active run
- `POST /issues/:id/conversation/interrupt`
  - interrupt the active run
- `GET /runs/:id/events`
  - load structured event history
- existing company WebSocket live events
  - continue to fan out run status/log/event updates

Internally, the server can translate those endpoints to Codex JSON-RPC or OpenClaw gateway calls.

Clients should never need to speak Codex JSON-RPC directly.

## Web and Mobile Strategy

Do not build the mobile app as an afterthought and do not make it a special backend.

The clean strategy is:

1. Define the operator conversation API first.
2. Keep streaming on the existing authenticated company WebSocket channel.
3. Share types and transcript-normalization logic in packages, not only inside `ui/`.
4. Build web and mobile clients against that same contract.

Recommended client structure:

- web: keep current React app
- mobile: build a separate Expo/React Native client
- shared packages:
  - shared API types and validators in `packages/shared`
  - transcript/event normalization extracted from web-only code into a reusable package if needed

This is how we satisfy “web and mobile should be interchangeable” without forcing one UI shell to fake the other.

## Local Adoption Flow

Paperclip should eventually expose a local adoption wizard:

1. Detect existing homes:
   - `~/.paperclip`
   - `~/.codex`
   - `~/.openclaw`
2. Show what was found:
   - existing Paperclip instance(s)
   - Codex threads
   - OpenClaw sessions
   - OpenClaw memory store presence
3. Let the user choose:
   - link to existing state
   - import a snapshot
   - ignore
4. Materialize control-plane metadata without rewriting upstream stores.

For a power-user local install, this wizard should be part of first-run onboarding.

## Approval Model

This is where the Codex app-server integration becomes truly valuable.

Paperclip should become the approval broker for runtime actions.

For Codex:

- command execution approval requests
- file change approval requests
- request-user-input prompts

For OpenClaw:

- any gateway/runtime approval-like prompts that need operator action

Operator behavior:

- approval appears in the same Paperclip run/issue context
- board can approve/reject from web or mobile
- the Paperclip bridge replies to the underlying runtime protocol

This is a much better fit than burying approvals inside CLI output logs.

## What Not To Do

- Do not create a second free-floating chat product inside Paperclip.
- Do not make clients talk to Codex app-server directly.
- Do not try to collapse Codex and OpenClaw into one fake universal runtime.
- Do not launch web and mobile as separate product models with different state semantics.
- Do not start by designing a giant “supports any CLI forever” abstraction. Keep the first bridge small and honest.

## Recommended Phases

## Phase 0: Adopt existing local state

Goal: stop Paperclip from acting like a fresh empty universe on a machine that already has years of agent state.

Build:

- detect existing `~/.paperclip`, `~/.codex`, and `~/.openclaw`
- support `shared` Codex-home mode
- add Codex thread indexing from the shared home
- add OpenClaw session indexing from the shared home
- attach the current app to the existing Paperclip instance by default

Why this comes first:

- it makes the project immediately useful on your machine
- it prevents early architectural mistakes around duplicate stores
- it gives the later UI real data to work with

## Phase 1: Codex-first interactive slice

Goal: make Paperclip genuinely useful for your own daily work as quickly as possible.

Build:

- issue-backed conversation UI for one selected agent
- new Codex app-server bridge
- send / steer / interrupt
- live transcript with tool and command events
- approval prompts in the operator UI
- durable thread mapping via `agent_task_sessions`

Why start here:

- Codex is your default runtime
- app-server is the biggest capability upgrade over current `codex_local`
- this produces the clearest “wow, Paperclip is now useful” moment

## Phase 2: Unify OpenClaw into the same operator surface

Build:

- same issue conversation UI for `openclaw_gateway`
- normalized event mapping
- better session metadata persistence
- compatible stop/steer semantics where possible

Outcome:

- the board can use one operator surface regardless of whether the agent is Codex-backed or OpenClaw-backed

## Phase 3: Mobile operator client

Build:

- Expo/React Native operator app
- inbox for approvals and active runs
- issue conversation view
- live transcript view
- interrupt / approve / re-task actions

Important:

Mobile should focus on supervision first, not full admin parity.

The first mobile value is:

- monitor active runs
- approve / reject
- interrupt
- send follow-up guidance

## Phase 4: Clean up and generalize the bridge seam

Only after Codex and OpenClaw both work:

- formalize the runtime bridge interface
- make transcript/event normalization package-level
- document how future runtimes can plug in

That gives extensibility without premature architecture.

## First Vertical Slice

If we want a concrete tracer bullet, it should be this:

1. Create a conversation-style issue assigned to a Codex-backed CEO or engineer agent.
2. Opening the issue shows prior messages and active session status.
3. Sending a message creates a Paperclip run and triggers `turn/start` on a managed Codex app-server thread.
4. The UI streams assistant deltas, tool calls, command output, and file changes live.
5. The board can hit stop, which triggers `turn/interrupt`.
6. If Codex asks for approval, the board sees it in Paperclip and can respond.
7. Closing and reopening the issue resumes the same Codex thread via `agent_task_sessions`.

If that works, the architecture is right.

## Main Risks

## 1. Approval brokering complexity

Codex app-server approvals are interactive and mid-turn. The bridge has to persist and route them correctly. This is the hardest part of the integration.

## 2. Session identity drift

If Paperclip, Codex, and OpenClaw each invent separate conversation identity rules, resumption becomes brittle. We need one canonical issue-backed session key policy.

## 3. Linked-state vs copy-state confusion

If the product silently mixes shared-home and managed-copy behavior, users will not know which data is canonical.

This needs to be explicit at both config and UI levels.

## 4. Transcript normalization drift

Codex emits richer item types than OpenClaw. We need a normalized model that keeps detail without forcing OpenClaw to look like Codex.

## 5. Mobile scope creep

Trying to ship full parity on mobile too early will slow down the core operator loop. Build the shared contract first, then the mobile client.

## Next Implementation Step

The next implementation step should not be “build everything.”

It should be:

1. add local state discovery for the existing Paperclip, Codex, and OpenClaw homes
2. support linked/shared-home mode for Codex instead of only seeded per-company homes
3. define the operator conversation API
4. add a Codex app-server bridge service behind a new adapter/runtime
5. wire one issue detail page to use it
6. prove send / stream / interrupt / approval end-to-end

After that, OpenClaw becomes an integration into an existing operator model, not a parallel product design problem.

## External References

- Codex app-server docs: https://developers.openai.com/codex/app-server
- Codex app-server source: https://github.com/openai/codex/tree/main/codex-rs/app-server
- OpenClaw docs: https://docs.openclaw.ai
- OpenClaw agent loop: https://docs.openclaw.ai/concepts/agent-loop
- OpenClaw gateway docs: https://docs.openclaw.ai/cli/gateway
- OpenClaw source: https://github.com/openclaw/openclaw
