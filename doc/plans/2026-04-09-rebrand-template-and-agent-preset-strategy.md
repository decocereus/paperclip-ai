# Rebrand, Template Strategy, and Agent Preset Architecture

## Context

Paperclip V1 is intentionally company-first:

- `doc/PRODUCT.md` defines Paperclip as a control plane for autonomous AI companies.
- `doc/SPEC-implementation.md` makes `company` the first-order V1 object and keeps communication anchored to tasks/comments.
- `doc/PRODUCT.md` also already points in the right direction by saying **agency / internal team / startup** should share the same underlying abstraction with different templates and labels.

That creates a good launch path and a future tension:

1. The launch product should remain optimized for founders, operators, indie hackers, and other professional users who rely heavily on agents.
2. The longer-term product should support a more civilian and social framing: a personal server with multiple agents that feel more like a shared space than a company org chart.
3. The public brand is likely to move away from `Paperclip`, while the repo and implementation may keep `Paperclip` as a codename for some time.

The purpose of this plan is to keep those three facts aligned so we do not ship a V1 that is hard to rebrand, hard to template, or hard to evolve into a broader “Discord for agents” product line later.

## Decisions

1. **Launch with the professional template first.**
   The first public product should remain company/operator-oriented and optimized for serious work.

2. **Keep one core platform underneath both templates.**
   We should not build separate backends or separate product ontologies for professional and civilian use cases.

3. **Treat `Paperclip` as the short-term codename, not the permanent public brand.**
   We should preserve implementation momentum while avoiding deeper coupling between the future brand and the current repo/package vocabulary.

4. **Treat “Discord for agents” as a positioning bridge, not the core ontology.**
   It is a strong mental model, especially for the later civilian template, but the product should not become a literal Discord clone at the core-model level.

5. **Make agent presets a first-class product layer.**
   Template choice, role choice, and model-family choice should all shape the hidden/default instructions an agent receives.

6. **Separate “private personal server” from “networked social graph.”**
   A user owning a server full of their own agents is a much nearer-term extension than cross-server interaction, public discovery, or other-people’s agents.

## Goals

1. Ship the professional product without painting the platform into a company-only corner.
2. Make future rebranding possible without a disruptive all-at-once rewrite.
3. Support two UI templates with different language, defaults, and onboarding over one system.
4. Introduce a clean instruction-preset stack for role-specific and model-specific agent behavior.
5. Preserve current V1 control-plane strengths: company/workspace visibility, task tracking, runs, approvals, budgets, and artifacts.

## Non-Goals

1. Renaming every `company` table, API, and type before launch.
2. Turning the product into a general chat app immediately.
3. Shipping cross-server social features in the same phase as the civilian template.
4. Forking the codebase into a “pro app” and a “consumer app.”
5. Picking the final public brand name in this document.

## Recommended Product Stack

There should be four distinct layers:

### 1. Core platform layer

Stable control-plane primitives:

- workspace tenancy root
- agents
- human members/operators
- work objects
- conversations/threads
- runs
- approvals
- artifacts
- budgets
- automations
- memory/knowledge

This layer should stay boring, durable, and as template-neutral as possible.

### 2. Template layer

This is where we change:

- UI copy
- navigation emphasis
- onboarding flow
- starter kits
- default agent roles
- default permissions and expectations
- visual presentation

This is where “professional company” and “personal server” should diverge most.

### 3. Agent preset layer

This shapes how agents behave by default:

- template-aware instructions
- role packs
- model-family packs
- environment/context injection
- optional company/server policy overlays

### 4. Brand layer

This is where we change:

- public name
- positioning language
- site messaging
- template names
- marketing explanations

This layer should be allowed to evolve without forcing a deep storage/model rewrite.

## Brand Architecture

We should explicitly separate codename, product brand, and template names.

| Concern | Near-term recommendation | Notes |
|---|---|---|
| Repo / internal codename | `Paperclip` | Keep for velocity unless a rename becomes operationally cheap. |
| Public umbrella brand | `TBD` | Must fit both work and personal/social agent use cases. Avoid names that imply only “company software.” |
| Launch positioning | “multi-agent workspace/control plane for founders and operators” | This is clearer and more credible than leading with “Discord for agents” on day one. |
| Secondary explainer | “Discord for agents” | Useful as a bridge metaphor, especially once template 2 exists. |
| Template 1 | professional/company template | Default launch shell. |
| Template 2 | personal/server template | Later shell for civilian users and personal multi-agent spaces. |

### Naming principle

Do not let the public brand carry the professional template’s ontology.

In other words:

- good umbrella brand: broad enough for work + personal + social
- good professional template labels: company, board, org, operator
- good personal template labels: server, rooms/channels, owner, members

Those should be related, but they should not be collapsed into one permanent naming scheme.

## Terminology Strategy

The current implementation can remain company-scoped while we gradually introduce a more neutral conceptual vocabulary in planning, design, and new APIs.

### Canonical long-term concepts

| Neutral concept | Current V1/storage reality | Professional template label | Personal template label | Notes |
|---|---|---|---|---|
| Workspace | `company` | Company | Server | The most important future alias. |
| Human member | board operator / user | Operator / Founder | Owner / Member | Keep board/operator framing in template 1. |
| Agent | `agent` | Agent / Employee | Agent / Bot | This can stay stable across templates. |
| Work item | `issue` | Task / Issue | Task / Request / Mission | Underlying task model can remain shared. |
| Conversation | issue comments + chat surfaces | Work thread | Channel/DM thread | The social template will likely emphasize this much more. |
| Run | `heartbeat_run` / live interaction run | Run / Session | Run / Session | Stable concept. |
| Artifact | docs/files/previews/outputs | Deliverable / Output | Result / File / Post | Stable concept with template-specific labels. |
| Approval | `approval` | Approval | Owner approval / restricted action | Some personal-server actions may still need explicit approval. |
| Automation | `routine` | Routine / Automation | Automation | Stable concept. |

### Important guardrail

We should **not** try to rename every storage/API concept before launch.

Instead:

1. Keep `company` in the database and current REST surface for V1 stability.
2. Start using `workspace` as the architecture/planning concept for anything new that is meant to survive the rebrand.
3. Introduce UI copy dictionaries and higher-level service aliases before any deep schema migration.
4. Only rename storage or HTTP primitives later if that migration clearly pays for itself.

## Template Strategy

### Template 1: Professional / company template

This is the launch default.

#### Core traits

- company framing
- board/operator oversight
- org chart and reporting lines
- task and approval centricity
- budget visibility
- output and delivery orientation

#### Positioning

- founders
- operators
- indie hackers
- agencies
- AI-native teams

#### What should remain true

- the control plane remains the center of gravity
- work stays attached to tasks/issues, runs, approvals, and outputs
- chat-like UX should still resolve to work objects rather than replacing them

### Template 2: Personal / server template

This should be split into two sub-phases to avoid strategy blur.

#### Template 2A: private personal server

This is the first realistic civilian expansion:

- one owner or household
- many personal agents
- lighter, more conversational framing
- more obvious room/channel metaphors
- less overt company/org-chart language

This can still run on the same core platform and mostly differ via:

- naming
- layout
- onboarding
- presets
- default surfaces

#### Template 2B: networked social graph

This is the much bigger future step:

- other people’s servers
- other people’s agents
- cross-server interactions
- discovery
- moderation
- trust and abuse controls
- public/private boundaries

This is **not** “just another template.”
It is a separate product phase with identity, trust, policy, and network-design consequences.

#### Design rule for template 2

Do not fake social features by overloading the professional model.

Examples:

- do not pretend `project` is a `channel`
- do not pretend every conversation is a task forever
- do not pretend cross-server interaction is only a copy rewrite

Template 2A can be mostly presentation + presets.
Template 2B requires deeper product work.

## Agent Preset Architecture

This should become a formal stack rather than a pile of ad hoc prompt text.

### Existing implementation hooks we should build on

The repo already has the right starting points:

- managed instruction bundles in `server/src/services/agent-instructions.ts`
- default instruction bundles for new agents in `server/src/services/default-agent-instructions.ts`
- adapter-specific instruction injection through `instructionsFilePath`
- prompt-template composition helpers in `packages/adapter-utils/src/server-utils.ts`
- optional adapter `detectModel` hooks in `packages/adapter-utils/src/types.ts`

That means we should build a preset system on top of current instruction-bundle infrastructure instead of inventing a parallel prompt system.

### Recommended instruction stack

Final agent behavior should be composed in this order:

1. **Platform base**
   Common Paperclip/platform rules: safety, reporting, artifact expectations, operator relationship.

2. **Template preset**
   Professional-company framing or personal-server framing.

3. **Role preset**
   Examples for template 1:
   - CEO
   - CTO
   - researcher
   - engineer
   - operator

   Examples for template 2:
   - host
   - planner
   - creative buddy
   - researcher
   - moderator

4. **Model-family preset**
   Different guidance for Codex, Claude, OpenClaw, Cursor, OpenCode, etc.

5. **Workspace/context layer**
   Goal, policies, available tools, permissions, team/server context, memory pointers.

6. **Agent custom instructions**
   User-authored specialization for this specific agent.

7. **Run/task prompt**
   The immediate issue/request/request-for-work.

### Selection rules

Preset resolution should follow this order:

1. explicit user override
2. explicit configured model
3. adapter `detectModel()` result
4. adapter-type fallback
5. platform default

### Storage strategy

Do not store the preset system only as one opaque prompt blob.

Instead, store structured selections plus compiled output:

- template id
- role preset id
- model preset strategy
- optional explicit model family override
- custom instructions body/files
- generated effective instructions bundle

### Recommended compatibility model

Adapters today mostly expect a single effective instructions file.
Because of that, the preset system should compile down to a managed bundle that still exposes a primary `AGENTS.md` entry file.

Recommended implementation shape:

- keep layered source material logically separate
- compile an effective `AGENTS.md` for runtime compatibility
- allow the UI to show both:
  - effective merged instructions
  - source layers and where they came from

This preserves compatibility while making the system inspectable.

## Rollout Plan

### Phase 0: strategy and language guardrails

Ship now:

- keep `Paperclip` as internal codename
- write and use this plan
- stop deepening company-only vocabulary in new strategic work unless it is V1-specific
- use neutral concepts like `workspace` and `template` in new planning where possible

### Phase 1: template-ready professional launch

Before or around launch:

1. add a template concept at the company/workspace level
2. make template 1 the explicit default
3. move UI copy toward dictionary-driven labels where feasible
4. keep storage/API company-scoped for stability
5. introduce preset-backed default agent creation

Recommended scope:

- `templateId` or equivalent on the top-level workspace/company object
- template-specific onboarding and starter roles
- role preset selection when creating an agent
- model-family preset selection or auto-detection fallback
- “effective instructions” preview in the agent instructions/config UI

### Phase 2: brand migration

After the professional product has real usage signal:

1. choose the umbrella brand
2. update public site and product shell branding
3. keep `Paperclip` codename internally until package/repo rename cost is justified
4. introduce user-facing neutral language where it reduces future rework

This phase should focus on public brand surfaces first, not on schema churn.

### Phase 3: template 2A private personal server

Build the civilian/personal shell on the same core:

- server-style navigation
- more conversational defaults
- personal/home use cases
- template-specific starter agents
- simplified setup and instructions

The key constraint is that it must still sit on the same run, artifact, approval, and automation substrate.

### Phase 4: template 2B networked social layer

Only after template 2A proves useful:

- cross-server interaction
- shared/public spaces
- other people’s agents
- moderation and trust systems
- external identity and discovery

This should be treated as a distinct roadmap effort, not as leftover UI polish.

## Risks and Mitigations

### Risk 1: ontology debt

If we keep hardcoding `company` into every new concept, the civilian template will feel bolted on.

**Mitigation**

- keep current storage stable
- move new product thinking toward neutral concepts
- centralize copy and template dictionaries

### Risk 2: overusing the Discord metaphor too early

If we lead too hard with “Discord for agents” before the product actually supports the right behaviors, we may sound casual, noisy, or unserious to professional buyers.

**Mitigation**

- lead template 1 with a more professional positioning
- use the Discord comparison selectively until template 2 exists

### Risk 3: prompt sprawl

If presets become giant hidden prompts, they will be hard to debug and expensive to run.

**Mitigation**

- make instruction layers explicit
- compile to one effective bundle for runtime
- keep layers concise and purpose-specific

### Risk 4: template divergence

If template 1 and template 2 drift into different product models, we will duplicate work across UI, API, and orchestration.

**Mitigation**

- enforce a single substrate
- treat templates as presentation/default packs first
- separate template 2A from networked template 2B

## Immediate Recommendations

1. Keep shipping the professional/company template as the default launch experience.
2. Treat `Paperclip` as an internal codename until the umbrella brand is chosen.
3. Introduce a template concept before the rebrand, even if only template 1 ships initially.
4. Build the agent preset system on top of the existing managed instructions bundle architecture.
5. Avoid deep schema/API renames until they are clearly worth the migration cost.
6. Plan template 2 as two phases:
   - private personal server
   - later social/network layer

## Practical Next Work

When this plan turns into implementation, the first concrete engineering slice should be:

1. Add a template identifier and template-aware copy/defaults at the top-level workspace/company surface.
2. Add preset metadata for agents:
   - role preset
   - model preset strategy
   - explicit override fields where needed
3. Compile layered presets into the existing managed `AGENTS.md` bundle path.
4. Expose an “effective instructions” view so users can inspect what an agent will actually receive.
5. Audit current public-facing copy and identify where `company` should remain V1-specific versus where neutral wording should start appearing.

That sequence moves us toward rebrand-readiness and template-readiness without destabilizing the current product.
