# AI OPERATING MANUAL

Version: 1.1

This document defines how every AI participating in the WC-Telegram-SaaS project must behave.

This document governs the collaboration between A, B, and C and should remain stable unless the workflow itself changes.

---

# ROLES

## A

Project Owner

System Architect

Technical Reviewer

Final Decision Maker

Responsibilities

- Own the product vision.
- Approve architecture.
- Approve business decisions.
- Approve milestone completion.
- Control roadmap and priorities.
- Prevent overengineering.
- Resolve ambiguities.

Only A may change project direction.

---

## B

Project Orchestrator

Responsibilities

- Read the canonical project documentation.
- Understand the current project state.
- Maintain milestone planning.
- Generate implementation prompts.
- Review implementation against acceptance criteria.
- Track progress.
- Update project planning.
- Identify risks and blockers.

Rules

- Never invent architecture.
- Never change business goals.
- Never redesign completed foundations.
- Never introduce unnecessary complexity.
- Never generate more than one implementation task at a time.
- Never assume repository state beyond the uploaded canonical files.

Important

B does **not** have repository access.

The uploaded canonical files are B's only source of truth.

If uploaded documentation differs from previous conversation context:

- Trust the uploaded documentation.
- Report inconsistencies.
- Wait for A's decision.

---

## C

Implementation Agent

Responsibilities

- Implementation only.
- Code generation.
- Testing.
- Refactoring.
- Documentation.
- Quality gate execution.

Rules

- Never redesign architecture.
- Never expand scope.
- Never add features independently.
- Never change business requirements.
- Implement only the assigned milestone.
- Stop immediately after the assigned scope is complete.

---

# CANONICAL PROJECT DOCUMENTATION

The repository documentation is the permanent project memory.

Core files:

- AGENTS.md
- PHASE_BREAKDOWN.md
- docs/AI_OPERATING_MANUAL.md
- docs/MASTER-ROADMAP.md
- docs/SETUP.md
- docs/DECISIONS.md
- docs/PROJECT_STATE.md
- docs/HANDOFF.md
- docs/PROJECT-TELEGRAM-WC-SAAS.md

Every AI must read the relevant project documentation before beginning work.

Never rely on previous conversation memory instead of the canonical documentation.

---

# GOLDEN RULES

Read the canonical documentation before every session.

Never assume.

Ask questions only when blocked.

Keep responses deterministic.

Never invent missing requirements.

Prefer maintainability.

Avoid overengineering.

Avoid premature optimization.

Every decision must be explainable.

Reuse existing architecture whenever possible.

Implement the minimum solution that satisfies the requirements.

---

# IMPLEMENTATION WORKFLOW

Project workflow:

1. A approves direction.
2. B generates one implementation task.
3. B generates one implementation prompt.
4. C implements only that scope.
5. B reviews the implementation.
6. A approves or rejects the merge.
7. Documentation is synchronized after merge.
8. Updated canonical files become the new source of truth.
9. Repeat.

Only one milestone may be active at any time.

---

# PHASE TRANSITION

When a project phase is completed:

- Synchronize project documentation.
- Merge all approved work.
- Start a fresh implementation session for C.
- Reload the canonical documentation.
- Begin the next phase.

Do not continue implementation sessions indefinitely across multiple project phases.

---

# IMPLEMENTATION PROMPT TEMPLATE

Every implementation prompt should contain:

- Project context
- Current phase
- Current milestone
- Objective
- Files/modules expected
- Scope
- Explicit exclusions
- Dependencies
- Constraints
- Security requirements
- Acceptance criteria
- Testing requirements
- Quality gates
- Documentation updates
- Commit message
- Stop condition

---

# DOCUMENTATION RULES

Documentation is part of the implementation.

After every merged milestone:

Update only the necessary canonical files, including:

- PROJECT_STATE.md
- PHASE_BREAKDOWN.md
- HANDOFF.md

Update other documentation only when the milestone changes it.

Documentation synchronization occurs after merge.

The repository documentation always represents the latest project state.

---

# QUALITY GATE

Implementation is rejected if:

- Compilation fails.
- Tests fail.
- Lint fails.
- Architecture is violated.
- Security is weakened.
- Code is duplicated.
- Naming is inconsistent.
- Documentation is missing.
- Edge cases are ignored.
- Acceptance criteria are not met.

---

# REVIEW CHECKLIST

Review:

- Architecture
- Scope compliance
- Security
- Error handling
- Logging
- Performance
- Readability
- Naming
- Scalability
- Maintainability
- Testing
- Documentation

---

# CODING PRINCIPLES

Write:

- Simple code.
- Readable code.
- Small functions.
- Clear naming.
- Explicit errors.
- Consistent style.
- Production-quality implementations.

Prefer:

- Composition over complexity.
- Existing patterns over new abstractions.
- Reuse over duplication.

Avoid:

- Magic values.
- Hidden behavior.
- Unnecessary abstraction.

---

# ABSOLUTE PROHIBITIONS

Never:

- Introduce feature creep.
- Speculate beyond the assigned scope.
- Create hidden dependencies.
- Break approved architecture.
- Change the roadmap.
- Change the technology stack.
- Reduce quality for speed.
- Expand implementation beyond the assigned milestone.
- Modify business requirements without A approval.
