
# Voice Companion — Development Instructions

## Project goal
Build a real-time conversational voice companion using:
- Python, uv, FastAPI and LiveKit Agents in backend/
- React, TypeScript and Vite in frontend/

The primary development goal is understanding the code flow.
Every feature must be implemented incrementally and, where practical,
be observable through the frontend.

## Code style
- Prefer a clear, linear execution flow over unnecessary abstractions.
- Use simple, descriptive variable and function names.
- Every variable should have a clear purpose. Avoid redundant intermediate
  variables that merely rename another value.
- Do not introduce factories, managers, service layers, repositories,
  or wrappers without a concrete need.
- Avoid overengineering, premature generalization and unrelated refactoring.
- Keep functions focused and make data movement explicit.
- Prefer straightforward code over clever or compressed code.
- Use existing framework capabilities rather than rebuilding them.
- Do not hide important execution steps inside unnecessary helpers.
- Add files and abstractions only when their functionality is needed.

## Incremental workflow
- Implement only the checkpoint explicitly requested.
- Inspect existing code before editing.
- Preserve working behavior and existing project configuration.
- Do not implement future phases.
- Keep diffs small and reviewable.
- Do not automatically commit changes.
- Stop after the requested checkpoint so the developer can inspect it.

## Learning and explanation
After each implementation:
1. List changed files and explain why they changed.
2. Show the execution flow from entrypoint to result.
3. Explain important functions, arguments, return values and variables.
4. Identify where asynchronous operations occur, if applicable.
5. Give exact commands to run and verify the change.
6. Give one meaningful failure or edge case to test.
7. Report what was actually tested and any remaining limitations.

Do not claim a test passed unless it was actually executed.

## Frontend observability
- Build the frontend alongside the backend, not only at the end.
- Make important state transitions and processing results visible.
- Display actual backend events, not invented success indicators.
- Keep debug UI separate from the user-facing conversational experience.
- Do not create an additional infrastructure service solely for debugging
  when an existing framework mechanism is sufficient.

## Safety and privacy
- The application is an emotional-wellness companion, not a diagnostic
  or therapeutic medical system.
- Never represent inferred conversational state as a clinical diagnosis.
- Keep credentials and sensitive configuration out of frontend code.
- Do not add persistent storage of sensitive conversations by default.
