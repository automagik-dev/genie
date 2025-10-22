Document critical learnings about Forge orchestration from Felipe's feedback:

**Context:** I made mistakes orchestrating RC release tasks. Felipe corrected me.

**Key Learnings:**

1. **Isolated Worktrees - No Cross-Task Waiting**
   - Each Forge task runs in isolated git worktree/sandbox
   - Tasks CANNOT wait for each other - they don't share filesystem
   - Task B cannot see Task A's changes until Task A is MERGED to base branch

2. **Humans Are The Merge Gate**
   - Only humans can review and merge Forge task PRs
   - Agents NEVER merge - always human decision
   - This is by design for quality control

3. **Sequential Dependency Pattern**
   - If Task B depends on Task A's changes:
     a. Launch Task A
     b. Wait for Task A to complete
     c. STOP and ask human: 'Please review and merge Task A'
     d. Human reviews/merges Task A to base branch
     e. THEN launch Task B (now has Task A's changes in base)

4. **Parallel Tasks**
   - Tasks CAN run in parallel if independent
   - Example: Fix test + Populate PR can run together
   - But final validation MUST wait for test fix to be merged

**My Mistake:**
- Launched Task 3 (validation) telling it to 'wait' for Task 1 (test fix)
- This is impossible - Task 3's worktree doesn't have Task 1's changes
- Task 3 would fail because test fix not in its base branch

**Correct Pattern:**
1. Launch Task 1 & 2 (parallel, independent)
2. Wait for completion
3. Ask human to merge Task 1
4. After merge, launch Task 3 (now has test fix)