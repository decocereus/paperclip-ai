# Roadmap

This document tracks the near-term evolution of Paperclip as a product.

For the live editable roadmap inside the app, use:

- `Instance Settings -> Roadmap`
- route: `/instance/settings/roadmap`

The in-app roadmap is the operational view.
This document is the repo-facing source of intent and context.

## Current Direction

Paperclip is in a strong `v0` place on web:

- linked runtime adoption for Paperclip, Codex, and OpenClaw is working
- issue-linked external conversations are working
- Codex live supervision is working
- OpenClaw gateway support is now viable for real usage
- direct agent chat is working
- the board meeting room is working with relays and mirrored replies
- issue creator provenance and issue-reuse guardrails are now in place

The next major move is not “more random features.”
It is finishing the product base, shipping mobile supervision, and then expanding into chat, docs, knowledge, and manager-agent workflows in a disciplined order.

## Recently Shipped

### 2026-04-09
Status: `completed`

**In-App Agent and Board Conversation Layer**

- issue chat for linked runtime sessions
- direct per-agent chat
- shared board meeting room
- relay execution through Paperclip instead of raw transcript leakage
- coordination events and concise board-facing replies
- issue creation provenance and duplicate-reuse guardrails

## Near-Term Timeline

### 2026-04-12
Status: `in_progress`

**Generalized Linked Runtime Supervision**

- finish Codex and OpenClaw hardening and restart behavior
- keep closing onboarding/auth/approval-sync papercuts
- define one reusable linked-runtime supervision architecture that other adapters can implement
- extend session discovery / snapshot / send / steer / interrupt semantics beyond only Codex and OpenClaw where possible
- avoid hardcoding future runtime UX per provider

### 2026-04-18
Status: `planned`

**Mobile Supervision MVP**

- active runs
- approvals
- conversation view
- send / steer / interrupt from mobile
- no mobile-side runtime protocol logic

### 2026-05-05
Status: `planned`

**Artifact-First Research Outputs**

- agents should produce docs and deliverables, not just transcripts
- Paperclip-native docs should become the first-class output model
- research, plans, briefs, and decision memos should be durable objects

### 2026-05-12
Status: `planned`

**Issue-Run Coordination Visibility**

- bring the same quality of coordination visibility from the board meeting into issue execution surfaces
- show agent-to-agent asks, status, and responses without turning issue detail into a debug console
- make asynchronous completions and follow-backs feel native

### 2026-05-20
Status: `idea`

**Knowledge Layer**

- uploaded files
- generated docs
- curated notes
- company memory vs personal memory
- retrieval surface for future manager workflows

### 2026-06-03
Status: `idea`

**Manager Agent**

- a high-trust personal manager agent
- memory + routines + connectors
- email, calendar, docs, and other operator workflows
- built as a real Paperclip-controlled agent, not a separate snowflake system

### 2026-06-17
Status: `idea`

**External Publishing and Sync**

- Notion sync/export
- external doc publishing paths
- connector-backed knowledge workflows

## Product Sequencing Principles

- Do not force chat-shaped work into issue-shaped UI.
- Do not force research outputs into terminal transcripts.
- Do not add connectors before the internal object model is strong.
- Do not make the manager agent a special architecture if it can be a well-equipped agent with better UX.
- Mobile should be a supervision client over the same Paperclip APIs, not a separate runtime implementation.
