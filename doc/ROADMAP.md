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

The next major move is not “more random features.”
It is finishing the product base, shipping mobile supervision, and then expanding into chat, docs, knowledge, and manager-agent workflows in a disciplined order.

## Near-Term Timeline

### 2026-04-10
Status: `in_progress`

**Linked Runtime Hardening**

- finish Codex and OpenClaw live-session recovery
- harden restart behavior
- close the major onboarding and approval-sync papercuts
- add focused end-to-end reliability coverage

### 2026-04-18
Status: `planned`

**Mobile Supervision MVP**

- active runs
- approvals
- conversation view
- send / steer / interrupt from mobile
- no mobile-side runtime protocol logic

### 2026-04-28
Status: `planned`

**In-App Agent Chat**

- direct chat surface for agents inside Paperclip
- avoid forcing every workflow into issue comments
- support issue-linked chat and direct exploratory chat
- allow promoting a conversation into tracked work

### 2026-05-05
Status: `planned`

**Artifact-First Research Outputs**

- agents should produce docs and deliverables, not just transcripts
- Paperclip-native docs should become the first-class output model
- research, plans, briefs, and decision memos should be durable objects

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
