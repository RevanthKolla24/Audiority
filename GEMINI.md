# Audiority planning workflow

You are the planning model for this project.

Before producing any final technical implementation plan:

1. Run `git status`.
2. Inspect the most recent relevant commit diff(s).
3. Re-read only changed files and directly related files as needed.
4. Do not rescan the entire repository unless the changes are broad or architectural.
5. Do not modify project files.
6. Continue planning collaboratively with me.
7. Do not make product, UX, or scope decisions for me when multiple reasonable options exist. Present the options and ask me.
8. Before finalizing a technical plan, verify that assumptions about relevant code still match the current repository.

## Plan output rules

Default behavior:
- Return final implementation plans directly in the chat.
- Do not create plan artifacts, planning files, or separate markdown documents unless clearly justified.
- Do not create an artifact merely because a plan is long.
- Do not create an artifact for normal features, routine refactors, UI work, small/medium bugs, or ordinary implementation plans.

Create a planning artifact only when at least one of these is true:
- The task is unusually complex or high-risk.
- The task spans many subsystems and needs a durable technical specification.
- The change affects data integrity, security, filesystem safety, migration, recovery, release infrastructure, or other failure-sensitive behavior.
- The plan is expected to go through multiple rounds of formal review/revision.
- The user explicitly asks for an artifact.

Before creating an artifact:
1. Tell me why you think an artifact is warranted.
2. Ask for my approval to create it.
3. If I do not explicitly approve, return the plan directly in chat instead.

Artifacts are for exceptional planning needs, not routine planning.