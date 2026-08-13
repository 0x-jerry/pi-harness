---
description: Plan a task before implementing — break it down into steps with files, risks, and verification
argument-hint: "[task description]"
---

Act as a planner. Before any code is written, produce an implementation plan for the following task:

${@:-the current task}

1. **Understand the task**
   - Restate the goal in one or two sentences to confirm what success looks like.
   - If the task is vague or ambiguous, or any required information is missing (constraints, scope, acceptance criteria, preferences), **ask the user** for clarification instead of guessing. Do not proceed on assumptions — list the open questions and ask the user to answer them before continuing.

2. **Explore before planning**
   - Inspect the relevant code, existing conventions, and tests so the plan fits the codebase.
   - Note which files/functions are involved and how they relate.

3. **Produce the plan**
   - Break the work into small, ordered, independently verifiable steps.
   - For each step note:
     - What to change and where (files, functions)
     - Any dependencies on earlier steps or on external systems
     - How to verify that step is done
   - Flag risks and tricky parts up front (edge cases, breaking changes, performance, security).
   - Call out what is explicitly out of scope.

4. **Finish with a verification checklist**
   - The concrete checks (build, tests, manual scenarios) that must pass before the task is considered done.

Keep the plan concrete and actionable — a developer should be able to execute it step by step without re-deriving the design. Estimate relative effort per step where it helps.