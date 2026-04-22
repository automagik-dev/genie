/**
 * Tests for task-service.ts — PG CRUD for all 11 task lifecycle tables.
 *
 * Requires pgserve to be running (auto-started via getConnection).
 * Each test suite uses a unique repo_path to isolate data.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getConnection } from './db.js';
import {
  type Actor,
  addDependency,
  addMember,
  assignTask,
  blockTask,
  checkoutTask,
  commentOnTask,
  createProject,
  createTag,
  createTask,
  createType,
  deletePreference,
  ensureProject,
  expireStaleCheckouts,
  findOrCreateConversation,
  forceUnlockTask,
  getBlockers,
  getCheckoutOwner,
  getConversation,
  getDependents,
  getMembers,
  getMessage,
  getMessages,
  getPreferences,
  getProjectByName,
  getProjectByRepoPath,
  getStageLog,
  getTask,
  getTaskActors,
  getTaskTags,
  getType,
  linkTask,
  listConversations,
  listProjects,
  listReleases,
  listTags,
  listTasks,
  listTasksForActor,
  listTypes,
  markDone,
  moveTask,
  releaseTask,
  removeActor,
  removeDependency,
  removeMember,
  resolveChannels,
  resolveTaskId,
  sendMessage,
  setPreference,
  setRelease,
  tagTask,
  unblockTask,
  untagTask,
  updateMessage,
  updateTask,
} from './task-service.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

// Unique repo path per test run to avoid collisions
const REPO = `/tmp/test-repo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const actor: Actor = { actorType: 'local', actorId: 'test-user' };
const actor2: Actor = { actorType: 'local', actorId: 'test-user-2' };

let sql: Awaited<ReturnType<typeof getConnection>>;

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
    sql = await getConnection();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  // ============================================================================
  // Tasks — CRUD lifecycle
  // ============================================================================

  describe('Task CRUD', () => {
    it('should create a task with defaults', async () => {
      const task = await createTask({ title: 'Test task' }, REPO);
      expect(task.id).toMatch(/^task-/);
      expect(task.seq).toBe(1);
      expect(task.title).toBe('Test task');
      expect(task.stage).toBe('draft');
      expect(task.status).toBe('ready');
      expect(task.priority).toBe('normal');
      expect(task.typeId).toBe('software');
      expect(task.repoPath).toBe(REPO);
    });

    it('should auto-increment seq per repo', async () => {
      const t2 = await createTask({ title: 'Second task' }, REPO);
      const t3 = await createTask({ title: 'Third task' }, REPO);
      expect(t2.seq).toBe(2);
      expect(t3.seq).toBe(3);
    });

    it('should create task with all fields', async () => {
      const task = await createTask(
        {
          title: 'Full task',
          description: 'A description',
          acceptanceCriteria: 'Must work',
          priority: 'high',
          dueDate: '2026-04-01T00:00:00Z',
          estimatedEffort: '3h',
          metadata: { source: 'test' },
        },
        REPO,
      );
      expect(task.description).toBe('A description');
      expect(task.acceptanceCriteria).toBe('Must work');
      expect(task.priority).toBe('high');
      expect(task.estimatedEffort).toBe('3h');
      expect(task.metadata).toEqual({ source: 'test' });
    });

    it('should create subtask with parent_id', async () => {
      const parent = await createTask({ title: 'Parent' }, REPO);
      const child = await createTask({ title: 'Child', parentId: parent.id }, REPO);
      expect(child.parentId).toBe(parent.id);
    });

    it('should get task by ID', async () => {
      const created = await createTask({ title: 'Get me' }, REPO);
      const fetched = await getTask(created.id, REPO);
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe('Get me');
    });

    it('should return null for non-existent task', async () => {
      const fetched = await getTask('task-nonexistent', REPO);
      expect(fetched).toBeNull();
    });

    it('should list tasks with filters', async () => {
      const repo2 = `${REPO}-list`;
      await createTask({ title: 'A', priority: 'urgent' }, repo2);
      await createTask({ title: 'B', priority: 'low' }, repo2);
      await createTask({ title: 'C', priority: 'urgent' }, repo2);

      const urgent = await listTasks({ repoPath: repo2, priority: 'urgent' });
      expect(urgent.length).toBe(2);
      expect(urgent.every((t) => t.priority === 'urgent')).toBe(true);

      const all = await listTasks({ repoPath: repo2 });
      expect(all.length).toBe(3);

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${repo2}`;
    });

    it('should update task fields', async () => {
      const task = await createTask({ title: 'Updateable' }, REPO);
      const updated = await updateTask(task.id, { title: 'Updated title', priority: 'high' }, REPO);
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('Updated title');
      expect(updated!.priority).toBe('high');
    });

    it('should block and unblock task', async () => {
      const task = await createTask({ title: 'Blockable' }, REPO);
      const blocked = await blockTask(task.id, 'waiting on API', actor, undefined, REPO);
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockedReason).toBe('waiting on API');

      const unblocked = await unblockTask(task.id, actor, undefined, REPO);
      expect(unblocked.status).toBe('ready');
      expect(unblocked.blockedReason).toBeNull();
    });
  });

  // ============================================================================
  // Short ID Resolution
  // ============================================================================

  describe('Short ID resolution', () => {
    it('should resolve #N to task ID', async () => {
      const repo3 = `${REPO}-shortid`;
      const task = await createTask({ title: 'Short ID test' }, repo3);
      const resolved = await resolveTaskId(`#${task.seq}`, repo3);
      expect(resolved).toBe(task.id);

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${repo3}`;
    });

    it('should resolve full task ID', async () => {
      const task = await createTask({ title: 'Full ID test' }, REPO);
      const resolved = await resolveTaskId(task.id, REPO);
      expect(resolved).toBe(task.id);
    });

    it('should return null for invalid #N', async () => {
      const resolved = await resolveTaskId('#99999', REPO);
      expect(resolved).toBeNull();
    });

    it('should return null for non-numeric #', async () => {
      const resolved = await resolveTaskId('#abc', REPO);
      expect(resolved).toBeNull();
    });
  });

  // ============================================================================
  // Stage transitions
  // ============================================================================

  describe('Stage transitions', () => {
    it('should move task to valid stage', async () => {
      const task = await createTask({ title: 'Moveable' }, REPO);
      const moved = await moveTask(task.id, 'brainstorm', actor, undefined, REPO);
      expect(moved.stage).toBe('brainstorm');
    });

    it('should reject invalid stage', async () => {
      const task = await createTask({ title: 'Invalid stage' }, REPO);
      await expect(moveTask(task.id, 'invalid_stage', actor, undefined, REPO)).rejects.toThrow(/Invalid stage/);
    });

    it('should log stage transition', async () => {
      const task = await createTask({ title: 'Log me' }, REPO);
      await moveTask(task.id, 'brainstorm', actor, undefined, REPO);
      const log = await getStageLog(task.id, REPO);
      expect(log.length).toBeGreaterThanOrEqual(1);
      expect(log[0].fromStage).toBe('draft');
      expect(log[0].toStage).toBe('brainstorm');
    });

    it('should move and comment inline', async () => {
      const task = await createTask({ title: 'Move+comment' }, REPO);
      await moveTask(task.id, 'brainstorm', actor, 'starting brainstorm', REPO);

      // Should have a conversation with the comment
      const conv = await findOrCreateConversation({ linkedEntity: 'task', linkedEntityId: task.id });
      const msgs = await getMessages(conv.id);
      expect(msgs.length).toBe(1);
      expect(msgs[0].body).toBe('starting brainstorm');
    });
  });

  // ============================================================================
  // Execution Locking (Checkout)
  // ============================================================================

  describe('Execution locking', () => {
    it('should checkout task atomically', async () => {
      const task = await createTask({ title: 'Checkout me' }, REPO);
      const checked = await checkoutTask(task.id, 'run-123', REPO);
      expect(checked.checkoutRunId).toBe('run-123');
      expect(checked.status).toBe('in_progress');
      expect(checked.executionLockedAt).not.toBeNull();
    });

    it('should fail checkout when claimed by different run', async () => {
      const task = await createTask({ title: 'Already claimed' }, REPO);
      await checkoutTask(task.id, 'run-A', REPO);
      await expect(checkoutTask(task.id, 'run-B', REPO)).rejects.toThrow(/already checked out/);
    });

    it('should allow re-checkout by same run', async () => {
      const task = await createTask({ title: 'Recheck' }, REPO);
      await checkoutTask(task.id, 'run-same', REPO);
      const again = await checkoutTask(task.id, 'run-same', REPO);
      expect(again.checkoutRunId).toBe('run-same');
    });

    it('should release checkout', async () => {
      const task = await createTask({ title: 'Releaseable' }, REPO);
      await checkoutTask(task.id, 'run-rel', REPO);
      const released = await releaseTask(task.id, 'run-rel', REPO);
      expect(released.checkoutRunId).toBeNull();
      expect(released.status).toBe('ready');
    });

    it('should fail release from wrong run', async () => {
      const task = await createTask({ title: 'Wrong release' }, REPO);
      await checkoutTask(task.id, 'run-X', REPO);
      await expect(releaseTask(task.id, 'run-Y', REPO)).rejects.toThrow(/not checked out by run/);
    });

    it('should force-unlock regardless of owner', async () => {
      const task = await createTask({ title: 'Force unlock' }, REPO);
      await checkoutTask(task.id, 'run-locked', REPO);
      const unlocked = await forceUnlockTask(task.id, REPO);
      expect(unlocked.checkoutRunId).toBeNull();
    });

    it('should get checkout owner', async () => {
      const task = await createTask({ title: 'Owner check' }, REPO);
      expect(await getCheckoutOwner(task.id, REPO)).toBeNull();
      await checkoutTask(task.id, 'run-own', REPO);
      expect(await getCheckoutOwner(task.id, REPO)).toBe('run-own');
    });

    it('should expire stale checkouts', async () => {
      const repo4 = `${REPO}-stale`;
      const task = await createTask({ title: 'Stale checkout' }, repo4);

      // Checkout and manually backdate the lock
      await checkoutTask(task.id, 'run-stale', repo4);
      await sql`
        UPDATE tasks SET
          execution_locked_at = now() - interval '20 minutes',
          checkout_timeout_ms = 60000
        WHERE id = ${task.id}
      `;

      const count = await expireStaleCheckouts(repo4);
      expect(count).toBe(1);

      const refreshed = await getTask(task.id, repo4);
      expect(refreshed!.checkoutRunId).toBeNull();
      expect(refreshed!.status).toBe('ready');

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${repo4}`;
    });
  });

  // ============================================================================
  // Actors
  // ============================================================================

  describe('Task actors', () => {
    it('should assign actor to task', async () => {
      const task = await createTask({ title: 'Assignable' }, REPO);
      const assigned = await assignTask(task.id, actor, 'assignee', {}, REPO);
      expect(assigned.actorId).toBe('test-user');
      expect(assigned.role).toBe('assignee');
    });

    it('should list task actors', async () => {
      const task = await createTask({ title: 'Multi-actor' }, REPO);
      await assignTask(task.id, actor, 'assignee', {}, REPO);
      await assignTask(task.id, actor2, 'reviewer', {}, REPO);
      const actors = await getTaskActors(task.id, REPO);
      expect(actors.length).toBe(2);
    });

    it('should upsert actor on conflict', async () => {
      const task = await createTask({ title: 'Upsert actor' }, REPO);
      await assignTask(task.id, actor, 'assignee', { canEdit: true }, REPO);
      await assignTask(task.id, actor, 'assignee', { canEdit: false }, REPO);
      const actors = await getTaskActors(task.id, REPO);
      const found = actors.find((a) => a.actorId === 'test-user' && a.role === 'assignee');
      expect(found).toBeTruthy();
    });

    it('should remove actor', async () => {
      const task = await createTask({ title: 'Removable actor' }, REPO);
      await assignTask(task.id, actor, 'assignee', {}, REPO);
      const removed = await removeActor(task.id, actor, 'assignee', REPO);
      expect(removed).toBe(true);
      const actors = await getTaskActors(task.id, REPO);
      expect(actors.length).toBe(0);
    });
  });

  // ============================================================================
  // Dependencies
  // ============================================================================

  describe('Dependencies', () => {
    it('should add depends_on dependency', async () => {
      const t1 = await createTask({ title: 'Dep A' }, REPO);
      const t2 = await createTask({ title: 'Dep B' }, REPO);
      const dep = await addDependency(t1.id, t2.id, 'depends_on', REPO);
      expect(dep.taskId).toBe(t1.id);
      expect(dep.dependsOnId).toBe(t2.id);
      expect(dep.depType).toBe('depends_on');
    });

    it('should add blocks dependency', async () => {
      const t1 = await createTask({ title: 'Blocker' }, REPO);
      const t2 = await createTask({ title: 'Blocked' }, REPO);
      const dep = await addDependency(t1.id, t2.id, 'blocks', REPO);
      expect(dep.depType).toBe('blocks');
    });

    it('should add relates_to dependency', async () => {
      const t1 = await createTask({ title: 'Related A' }, REPO);
      const t2 = await createTask({ title: 'Related B' }, REPO);
      const dep = await addDependency(t1.id, t2.id, 'relates_to', REPO);
      expect(dep.depType).toBe('relates_to');
    });

    it('should get blockers and dependents', async () => {
      const t1 = await createTask({ title: 'Get deps A' }, REPO);
      const t2 = await createTask({ title: 'Get deps B' }, REPO);
      await addDependency(t1.id, t2.id, 'depends_on', REPO);

      const blockers = await getBlockers(t1.id, REPO);
      expect(blockers.length).toBe(1);
      expect(blockers[0].dependsOnId).toBe(t2.id);

      const dependents = await getDependents(t2.id, REPO);
      expect(dependents.length).toBe(1);
      expect(dependents[0].taskId).toBe(t1.id);
    });

    it('should remove dependency', async () => {
      const t1 = await createTask({ title: 'Remove dep A' }, REPO);
      const t2 = await createTask({ title: 'Remove dep B' }, REPO);
      await addDependency(t1.id, t2.id, 'depends_on', REPO);
      const removed = await removeDependency(t1.id, t2.id, REPO);
      expect(removed).toBe(true);
      const blockers = await getBlockers(t1.id, REPO);
      expect(blockers.length).toBe(0);
    });

    it('should reject self-dependency via CHECK constraint', async () => {
      const t1 = await createTask({ title: 'Self dep' }, REPO);
      await expect(addDependency(t1.id, t1.id, 'depends_on', REPO)).rejects.toThrow();
    });
  });

  // ============================================================================
  // Conversations
  // ============================================================================

  describe('Conversations', () => {
    it('should create a group conversation', async () => {
      const conv = await findOrCreateConversation({
        type: 'group',
        name: 'Test group',
        members: [actor, actor2],
      });
      expect(conv.id).toMatch(/^conv-/);
      expect(conv.type).toBe('group');
      expect(conv.name).toBe('Test group');
    });

    it('should create and find task-linked conversation', async () => {
      const task = await createTask({ title: 'Conv task' }, REPO);
      const conv1 = await findOrCreateConversation({
        linkedEntity: 'task',
        linkedEntityId: task.id,
        name: `Task ${task.id}`,
      });
      // Second call should return same conversation
      const conv2 = await findOrCreateConversation({
        linkedEntity: 'task',
        linkedEntityId: task.id,
      });
      expect(conv1.id).toBe(conv2.id);
    });

    it('should create DM and find existing', async () => {
      const convA = await findOrCreateConversation({
        type: 'dm',
        members: [actor, actor2],
      });
      const convB = await findOrCreateConversation({
        type: 'dm',
        members: [actor, actor2],
      });
      expect(convA.id).toBe(convB.id);
    });

    it('should get conversation by ID', async () => {
      const conv = await findOrCreateConversation({ type: 'group', name: 'Getable' });
      const fetched = await getConversation(conv.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('Getable');
    });

    it('should list conversations for actor', async () => {
      const conv = await findOrCreateConversation({
        type: 'group',
        name: 'Listable',
        members: [actor],
      });
      const list = await listConversations(actor);
      expect(list.some((c) => c.id === conv.id)).toBe(true);
    });

    it('should add and remove members', async () => {
      const conv = await findOrCreateConversation({ type: 'group', name: 'Members test' });
      await addMember(conv.id, actor, 'admin');
      await addMember(conv.id, actor2, 'member');

      let members = await getMembers(conv.id);
      expect(members.length).toBe(2);

      await removeMember(conv.id, actor2);
      members = await getMembers(conv.id);
      expect(members.length).toBe(1);
      expect(members[0].actorId).toBe('test-user');
    });

    it('should create threaded sub-conversation from message', async () => {
      const conv = await findOrCreateConversation({ type: 'group', name: 'Thread parent' });
      await addMember(conv.id, actor);
      const msg = await sendMessage(conv.id, actor, 'Start thread here');

      const thread = await findOrCreateConversation({
        parentMessageId: msg.id,
        name: 'Thread',
        members: [actor],
      });
      expect(thread.parentMessageId).toBe(msg.id);
      expect(thread.id).not.toBe(conv.id);

      // Second call returns same thread
      const thread2 = await findOrCreateConversation({ parentMessageId: msg.id });
      expect(thread2.id).toBe(thread.id);
    });
  });

  // ============================================================================
  // Messages
  // ============================================================================

  describe('Messages', () => {
    it('should send and get messages', async () => {
      const conv = await findOrCreateConversation({ type: 'group', name: 'Msg test' });
      await addMember(conv.id, actor);
      const msg = await sendMessage(conv.id, actor, 'Hello world');
      expect(msg.body).toBe('Hello world');
      expect(msg.senderId).toBe('test-user');

      const fetched = await getMessage(msg.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.body).toBe('Hello world');
    });

    it('should list messages with pagination', async () => {
      const conv = await findOrCreateConversation({ type: 'group', name: 'Paginate' });
      await addMember(conv.id, actor);
      await sendMessage(conv.id, actor, 'msg 1');
      await sendMessage(conv.id, actor, 'msg 2');
      await sendMessage(conv.id, actor, 'msg 3');

      const page1 = await getMessages(conv.id, { limit: 2 });
      expect(page1.length).toBe(2);

      const page2 = await getMessages(conv.id, { limit: 2, offset: 2 });
      expect(page2.length).toBe(1);
    });

    it('should support reply_to_id', async () => {
      const conv = await findOrCreateConversation({ type: 'group', name: 'Reply test' });
      await addMember(conv.id, actor);
      const original = await sendMessage(conv.id, actor, 'Original');
      const reply = await sendMessage(conv.id, actor2, 'Reply to that', original.id);
      expect(reply.replyToId).toBe(original.id);
    });

    it('should update message body', async () => {
      const conv = await findOrCreateConversation({ type: 'group', name: 'Update msg' });
      await addMember(conv.id, actor);
      const msg = await sendMessage(conv.id, actor, 'Before');
      const updated = await updateMessage(msg.id, 'After');
      expect(updated!.body).toBe('After');
    });

    it('should comment on task (auto-creates conversation)', async () => {
      const task = await createTask({ title: 'Commentable' }, REPO);
      const msg = await commentOnTask(task.id, actor, 'First comment', REPO);
      expect(msg.body).toBe('First comment');

      // Second comment should reuse same conversation
      const msg2 = await commentOnTask(task.id, actor, 'Second comment', REPO);
      expect(msg2.conversationId).toBe(msg.conversationId);

      // Get all messages
      const messages = await getMessages(msg.conversationId);
      expect(messages.length).toBe(2);
    });

    it('should thread messages in sub-conversation isolated from parent', async () => {
      const conv = await findOrCreateConversation({ type: 'group', name: 'Thread isolation' });
      await addMember(conv.id, actor);
      const parentMsg = await sendMessage(conv.id, actor, 'Parent message');
      await sendMessage(conv.id, actor, 'Another parent message');

      const thread = await findOrCreateConversation({
        parentMessageId: parentMsg.id,
        name: 'Sub-thread',
        members: [actor],
      });
      await sendMessage(thread.id, actor, 'Thread message 1');
      await sendMessage(thread.id, actor, 'Thread message 2');

      // Parent conversation should have 2 messages
      const parentMsgs = await getMessages(conv.id);
      expect(parentMsgs.length).toBe(2);

      // Thread should have 2 messages
      const threadMsgs = await getMessages(thread.id);
      expect(threadMsgs.length).toBe(2);
    });
  });

  // ============================================================================
  // Tags
  // ============================================================================

  describe('Tags', () => {
    it('should list default tags', async () => {
      const tags = await listTags();
      expect(tags.length).toBeGreaterThanOrEqual(6);
      const names = tags.map((t) => t.name);
      expect(names).toContain('Bug');
      expect(names).toContain('Feature');
    });

    it('should create custom tag', async () => {
      const tag = await createTag({ id: `test-security-${Date.now()}`, name: 'Security', color: '#dc2626' });
      expect(tag.name).toBe('Security');
      expect(tag.color).toBe('#dc2626');
    });

    it('should tag and untag task', async () => {
      const task = await createTask({ title: 'Taggable' }, REPO);
      await tagTask(task.id, ['bug', 'urgent'], actor, REPO);

      let tags = await getTaskTags(task.id, REPO);
      expect(tags.length).toBe(2);

      await untagTask(task.id, 'urgent', REPO);
      tags = await getTaskTags(task.id, REPO);
      expect(tags.length).toBe(1);
      expect(tags[0].id).toBe('bug');
    });

    it('should be idempotent on duplicate tag', async () => {
      const task = await createTask({ title: 'Idempotent tag' }, REPO);
      await tagTask(task.id, ['bug'], actor, REPO);
      await tagTask(task.id, ['bug'], actor, REPO);
      const tags = await getTaskTags(task.id, REPO);
      expect(tags.length).toBe(1);
    });
  });

  // ============================================================================
  // Types
  // ============================================================================

  describe('Types', () => {
    it('should list built-in software type', async () => {
      const types = await listTypes();
      expect(types.some((t) => t.id === 'software')).toBe(true);
      const sw = types.find((t) => t.id === 'software');
      expect(sw!.isBuiltin).toBe(true);
      expect(Array.isArray(sw!.stages)).toBe(true);
    });

    it('should get type by ID', async () => {
      const sw = await getType('software');
      expect(sw).not.toBeNull();
      expect(sw!.name).toBe('Software Development');
      const stages = sw!.stages as { name: string }[];
      expect(stages.length).toBe(7);
      expect(stages[0].name).toBe('draft');
      expect(stages[6].name).toBe('ship');
    });

    it('should create custom type with stages', async () => {
      const typeId = `hiring-${Date.now()}`;
      const stages = [
        { name: 'sourcing', label: 'Sourcing', gate: 'human' },
        { name: 'screening', label: 'Screening', gate: 'human' },
        { name: 'interview', label: 'Interview', gate: 'human' },
        { name: 'offer', label: 'Offer', gate: 'human' },
        { name: 'hired', label: 'Hired', gate: 'human' },
      ];
      const created = await createType({
        id: typeId,
        name: 'Hiring Pipeline',
        description: 'Recruiting process',
        stages,
      });
      expect(created.id).toBe(typeId);
      expect(created.isBuiltin).toBe(false);
      expect((created.stages as unknown[]).length).toBe(5);

      // Task with custom type should validate stage
      const task = await createTask({ title: 'Hire someone', typeId, stage: 'sourcing' }, REPO);
      expect(task.stage).toBe('sourcing');

      // Invalid stage for custom type should fail
      await expect(createTask({ title: 'Bad stage', typeId, stage: 'draft' }, REPO)).rejects.toThrow(/Invalid stage/);

      // Cleanup
      await sql`DELETE FROM tasks WHERE type_id = ${typeId}`;
      await sql`DELETE FROM task_types WHERE id = ${typeId}`;
    });
  });

  // ============================================================================
  // Releases
  // ============================================================================

  describe('Releases', () => {
    it('should set release on tasks', async () => {
      const repo5 = `${REPO}-releases`;
      const t1 = await createTask({ title: 'Release A' }, repo5);
      const t2 = await createTask({ title: 'Release B' }, repo5);
      const count = await setRelease([t1.id, t2.id], 'v0.1', repo5);
      expect(count).toBe(2);

      const refreshed = await getTask(t1.id, repo5);
      expect(refreshed!.releaseId).toBe('v0.1');

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${repo5}`;
    });

    it('should list releases with counts', async () => {
      const repo6 = `${REPO}-rellist`;
      const t1 = await createTask({ title: 'RL A' }, repo6);
      const t2 = await createTask({ title: 'RL B' }, repo6);
      const t3 = await createTask({ title: 'RL C' }, repo6);
      await setRelease([t1.id, t2.id], 'v1.0', repo6);
      await setRelease([t3.id], 'v1.1', repo6);

      const releases = await listReleases(repo6);
      expect(releases.length).toBe(2);
      expect(releases.find((r) => r.releaseId === 'v1.0')!.count).toBe(2);
      expect(releases.find((r) => r.releaseId === 'v1.1')!.count).toBe(1);

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${repo6}`;
    });
  });

  // ============================================================================
  // Notification Preferences
  // ============================================================================

  describe('Notification preferences', () => {
    it('should set and get preferences', async () => {
      const testActor: Actor = { actorType: 'local', actorId: `notif-user-${Date.now()}` };
      await setPreference(testActor, 'whatsapp', { priorityThreshold: 'high', isDefault: true });
      await setPreference(testActor, 'tmux', { priorityThreshold: 'normal' });

      const prefs = await getPreferences(testActor);
      expect(prefs.length).toBe(2);
      const wa = prefs.find((p) => p.channel === 'whatsapp');
      expect(wa!.priorityThreshold).toBe('high');
      expect(wa!.isDefault).toBe(true);
    });

    it('should upsert on conflict', async () => {
      const testActor: Actor = { actorType: 'local', actorId: `notif-upsert-${Date.now()}` };
      await setPreference(testActor, 'slack', { priorityThreshold: 'normal' });
      await setPreference(testActor, 'slack', { priorityThreshold: 'urgent' });

      const prefs = await getPreferences(testActor);
      expect(prefs.length).toBe(1);
      expect(prefs[0].priorityThreshold).toBe('urgent');
    });

    it('should resolve channels by priority', async () => {
      const testActor: Actor = { actorType: 'local', actorId: `notif-resolve-${Date.now()}` };
      await setPreference(testActor, 'whatsapp', { priorityThreshold: 'urgent', isDefault: true });
      await setPreference(testActor, 'tmux', { priorityThreshold: 'normal' });
      await setPreference(testActor, 'email', { priorityThreshold: 'low' });

      // Normal priority should match tmux and email (not whatsapp which needs urgent)
      const normalChannels = await resolveChannels(testActor, 'normal');
      expect(normalChannels).toContain('tmux');
      expect(normalChannels).toContain('email');
      expect(normalChannels).not.toContain('whatsapp');

      // Urgent priority should match all
      const urgentChannels = await resolveChannels(testActor, 'urgent');
      expect(urgentChannels).toContain('whatsapp');
      expect(urgentChannels).toContain('tmux');
      expect(urgentChannels).toContain('email');

      // Low priority should only match email
      const lowChannels = await resolveChannels(testActor, 'low');
      expect(lowChannels).toContain('email');
      expect(lowChannels).not.toContain('tmux');
    });
  });

  // ============================================================================
  // Recursive parent chains
  // ============================================================================

  describe('Recursive parent chains', () => {
    it('should support multi-level nesting', async () => {
      const repo7 = `${REPO}-nesting`;
      const grandparent = await createTask({ title: 'Grandparent' }, repo7);
      const parent = await createTask({ title: 'Parent', parentId: grandparent.id }, repo7);
      const child = await createTask({ title: 'Child', parentId: parent.id }, repo7);

      expect(child.parentId).toBe(parent.id);
      expect(parent.parentId).toBe(grandparent.id);
      expect(grandparent.parentId).toBeNull();

      // List children of parent
      const children = await listTasks({ repoPath: repo7, parentId: parent.id });
      expect(children.length).toBe(1);
      expect(children[0].id).toBe(child.id);

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${repo7}`;
    });
  });

  // ============================================================================
  // List filters
  // ============================================================================

  describe('List filters', () => {
    it('should filter by stage', async () => {
      const repo8 = `${REPO}-filters`;
      const t1 = await createTask({ title: 'Filter A' }, repo8);
      await createTask({ title: 'Filter B' }, repo8);
      await moveTask(t1.id, 'brainstorm', actor, undefined, repo8);

      const drafts = await listTasks({ repoPath: repo8, stage: 'draft' });
      expect(drafts.length).toBe(1);

      const brainstorms = await listTasks({ repoPath: repo8, stage: 'brainstorm' });
      expect(brainstorms.length).toBe(1);
      expect(brainstorms[0].id).toBe(t1.id);

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${repo8}`;
    });

    it('should filter by status', async () => {
      const repo9 = `${REPO}-status`;
      const t1 = await createTask({ title: 'Status A' }, repo9);
      await createTask({ title: 'Status B' }, repo9);
      await blockTask(t1.id, 'reason', actor, undefined, repo9);

      const blocked = await listTasks({ repoPath: repo9, status: 'blocked' });
      expect(blocked.length).toBe(1);
      expect(blocked[0].id).toBe(t1.id);

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${repo9}`;
    });

    it('should filter by due date', async () => {
      const repo10 = `${REPO}-due`;
      await createTask({ title: 'Due A', dueDate: '2026-03-25T00:00:00Z' }, repo10);
      await createTask({ title: 'Due B', dueDate: '2026-04-15T00:00:00Z' }, repo10);
      await createTask({ title: 'No due' }, repo10);

      const beforeApril = await listTasks({ repoPath: repo10, dueBefore: '2026-04-01T00:00:00Z' });
      expect(beforeApril.length).toBe(1);
      expect(beforeApril[0].title).toBe('Due A');

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${repo10}`;
    });
  });

  // ============================================================================
  // Mark Done
  // ============================================================================

  describe('markDone', () => {
    it('should mark task as done and release checkout', async () => {
      const repo11 = `${REPO}-done`;
      const task = await createTask({ title: 'Done test' }, repo11);
      await checkoutTask(task.id, 'run-1', repo11);

      const done = await markDone(task.id, actor, 'shipped', repo11);
      expect(done.status).toBe('done');
      expect(done.endedAt).not.toBeNull();
      expect(done.checkoutRunId).toBeNull();

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${repo11}`;
    });
  });

  // ============================================================================
  // Delete Preference
  // ============================================================================

  describe('deletePreference', () => {
    it('should delete a notification preference', async () => {
      const testActor: Actor = { actorType: 'local', actorId: `del-pref-${Date.now()}` };
      await setPreference(testActor, 'slack', { priorityThreshold: 'normal' });

      const removed = await deletePreference(testActor, 'slack');
      expect(removed).toBe(true);

      const prefs = await getPreferences(testActor);
      expect(prefs.length).toBe(0);
    });

    it('should return false for non-existent preference', async () => {
      const testActor: Actor = { actorType: 'local', actorId: `del-pref-ne-${Date.now()}` };
      const removed = await deletePreference(testActor, 'whatsapp');
      expect(removed).toBe(false);
    });
  });

  // ============================================================================
  // List Tasks For Actor
  // ============================================================================

  describe('listTasksForActor', () => {
    it('should list tasks assigned to an actor', async () => {
      const repo12 = `${REPO}-actorlist`;
      const t1 = await createTask({ title: 'Actor A' }, repo12);
      await createTask({ title: 'Actor B' }, repo12);
      await assignTask(t1.id, actor, 'assignee', {}, repo12);

      const tasks = await listTasksForActor(actor, { repoPath: repo12 });
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe(t1.id);

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${repo12}`;
    });
  });

  // ============================================================================
  // Projects
  // ============================================================================

  describe('Projects', () => {
    const projRepo = `${REPO}-projects`;
    const projRepo2 = `${REPO}-projects2`;

    afterAll(async () => {
      if (sql) {
        await sql`DELETE FROM tasks WHERE repo_path LIKE ${`${REPO}-projects%`}`;
        await sql`DELETE FROM projects WHERE repo_path LIKE ${`${REPO}-projects%`}`;
        await sql`DELETE FROM projects WHERE name LIKE 'test-virtual-%'`;
      }
    });

    it('should create a repo-backed project', async () => {
      const proj = await createProject({ name: 'test-proj-repo', repoPath: projRepo });
      expect(proj.name).toBe('test-proj-repo');
      expect(proj.repoPath).toBe(projRepo);
      expect(proj.id).toMatch(/^proj-/);
    });

    it('should create a virtual project (no repo)', async () => {
      const proj = await createProject({ name: 'test-virtual-ops', description: 'Ops board' });
      expect(proj.name).toBe('test-virtual-ops');
      expect(proj.repoPath).toBeNull();
      expect(proj.description).toBe('Ops board');
    });

    it('should list all projects', async () => {
      const projects = await listProjects();
      expect(projects.length).toBeGreaterThanOrEqual(2);
      const names = projects.map((p) => p.name);
      expect(names).toContain('test-proj-repo');
      expect(names).toContain('test-virtual-ops');
    });

    it('should get project by name', async () => {
      const proj = await getProjectByName('test-proj-repo');
      expect(proj).not.toBeNull();
      expect(proj!.repoPath).toBe(projRepo);
    });

    it('should return null for unknown project name', async () => {
      const proj = await getProjectByName('nonexistent-project');
      expect(proj).toBeNull();
    });

    it('should get project by repo path', async () => {
      const proj = await getProjectByRepoPath(projRepo);
      expect(proj).not.toBeNull();
      expect(proj!.name).toBe('test-proj-repo');
    });

    it('should auto-create project via ensureProject', async () => {
      const projId = await ensureProject(projRepo2);
      expect(projId).toMatch(/^proj-/);

      // Second call should return same ID
      const projId2 = await ensureProject(projRepo2);
      expect(projId2).toBe(projId);
    });

    it('should set project_id on created tasks', async () => {
      const task = await createTask({ title: 'Project task' }, projRepo);
      expect(task.projectId).not.toBeNull();

      const proj = await getProjectByRepoPath(projRepo);
      expect(task.projectId).toBe(proj!.id);
    });

    it('should list tasks across all projects', async () => {
      await createTask({ title: 'All-proj test A' }, projRepo);
      await createTask({ title: 'All-proj test B' }, projRepo2);

      const allTasks = await listTasks({ allProjects: true });
      expect(allTasks.length).toBeGreaterThanOrEqual(2);
    });

    it('should list tasks scoped to a project by name', async () => {
      const proj = await getProjectByRepoPath(projRepo);
      const projName = proj!.name;

      const tasks = await listTasks({ projectName: projName });
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      for (const t of tasks) {
        expect(t.projectId).toBe(proj!.id);
      }
    });

    it('should round-trip: create virtual project → create task with explicit projectId → list by projectName', async () => {
      const projName = `test-virtual-roundtrip-${Date.now()}`;
      const taskRepo = `${REPO}-roundtrip`;

      // 1. Create virtual project (no repoPath) — mimics handleTaskCreate --project flow
      const project = await createProject({ name: projName });
      expect(project.id).toMatch(/^proj-/);
      expect(project.repoPath).toBeNull();

      // 2. Create task with explicit projectId — mimics createTask(input, repoPath, projectId)
      const task = await createTask({ title: 'Round-trip test task' }, taskRepo, project.id);
      expect(task.projectId).toBe(project.id);
      expect(task.repoPath).toBe(taskRepo);

      // 3. List by projectName — mimics genie task list --project <name>
      const tasks = await listTasks({ projectName: projName });
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      const found = tasks.find((t) => t.id === task.id);
      expect(found).not.toBeUndefined();
      expect(found!.projectId).toBe(project.id);

      // 4. Verify getProjectByName returns same project
      const lookedUp = await getProjectByName(projName);
      expect(lookedUp).not.toBeNull();
      expect(lookedUp!.id).toBe(project.id);

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${taskRepo}`;
      await sql`DELETE FROM projects WHERE name = ${projName}`;
    });

    it('should round-trip with listTasksForActor and --project filter', async () => {
      const projName = `test-virtual-actor-${Date.now()}`;
      const taskRepo = `${REPO}-actor-proj`;

      // Create virtual project and task
      const project = await createProject({ name: projName });
      const task = await createTask({ title: 'Actor project task' }, taskRepo, project.id);
      await assignTask(task.id, actor, 'assignee', {}, taskRepo);

      // List via listTasksForActor with projectName filter
      const tasks = await listTasksForActor(actor, { projectName: projName });
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      const found = tasks.find((t) => t.id === task.id);
      expect(found).not.toBeUndefined();
      expect(found!.projectId).toBe(project.id);

      // Cleanup
      await sql`DELETE FROM task_actors WHERE task_id = ${task.id}`;
      await sql`DELETE FROM tasks WHERE repo_path = ${taskRepo}`;
      await sql`DELETE FROM projects WHERE name = ${projName}`;
    });

    it('should find auto-created projects by name in subsequent commands', async () => {
      const autoRepo = `${REPO}-auto-find`;

      // ensureProject auto-creates with basename
      const projId = await ensureProject(autoRepo);

      // The auto-created project should be findable by its name (basename of path)
      const parts = autoRepo.split('/');
      const expectedName = parts[parts.length - 1];
      const found = await getProjectByName(expectedName);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(projId);

      // Create task and list by project name
      const task = await createTask({ title: 'Auto-find task' }, autoRepo);
      expect(task.projectId).toBe(projId);

      const tasks = await listTasks({ projectName: expectedName });
      expect(tasks.some((t) => t.id === task.id)).toBe(true);

      // Cleanup
      await sql`DELETE FROM tasks WHERE repo_path = ${autoRepo}`;
      await sql`DELETE FROM projects WHERE repo_path = ${autoRepo}`;
    });

    it('should honor projectName filter even when allProjects is true (#971)', async () => {
      const projNameA = `test-all-proj-a-${Date.now()}`;
      const projNameB = `test-all-proj-b-${Date.now()}`;
      const repoA = `${REPO}-all-proj-a`;
      const repoB = `${REPO}-all-proj-b`;

      // Create two projects with tasks
      const projectA = await createProject({ name: projNameA });
      const projectB = await createProject({ name: projNameB });
      await createTask({ title: 'Task in A' }, repoA, projectA.id);
      await createTask({ title: 'Task in B' }, repoB, projectB.id);

      // allProjects=true + projectName should return ONLY tasks in that project
      const filtered = await listTasks({ allProjects: true, projectName: projNameA });
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      for (const t of filtered) {
        expect(t.projectId).toBe(projectA.id);
      }

      // Same for listTasksForActor
      await assignTask(filtered[0].id, actor, 'assignee', {}, repoA);
      const actorFiltered = await listTasksForActor(actor, { allProjects: true, projectName: projNameA });
      expect(actorFiltered.length).toBeGreaterThanOrEqual(1);
      for (const t of actorFiltered) {
        expect(t.projectId).toBe(projectA.id);
      }

      // Cleanup
      await sql`DELETE FROM task_actors WHERE task_id = ${filtered[0].id}`;
      await sql`DELETE FROM tasks WHERE repo_path IN (${repoA}, ${repoB})`;
      await sql`DELETE FROM projects WHERE name IN (${projNameA}, ${projNameB})`;
    });
  });

  // ============================================================================
  // External Linking
  // ============================================================================

  describe('External Linking', () => {
    it('should create a task with external_id and external_url', async () => {
      const task = await createTask(
        {
          title: 'Linked task',
          externalId: 'automagik-dev/genie#789',
          externalUrl: 'https://github.com/automagik-dev/genie/issues/789',
        },
        REPO,
      );
      expect(task.externalId).toBe('automagik-dev/genie#789');
      expect(task.externalUrl).toBe('https://github.com/automagik-dev/genie/issues/789');
    });

    it('should create a task without external fields (null by default)', async () => {
      const task = await createTask({ title: 'No link task' }, REPO);
      expect(task.externalId).toBeNull();
      expect(task.externalUrl).toBeNull();
    });

    it('should link an existing task via linkTask()', async () => {
      const task = await createTask({ title: 'To be linked' }, REPO);
      expect(task.externalId).toBeNull();

      const updated = await linkTask(task.id, 'JIRA-456', 'https://jira.example.com/JIRA-456', REPO);
      expect(updated).not.toBeNull();
      expect(updated!.externalId).toBe('JIRA-456');
      expect(updated!.externalUrl).toBe('https://jira.example.com/JIRA-456');
    });

    it('should update external fields via updateTask()', async () => {
      const task = await createTask(
        { title: 'Update link', externalId: 'old#1', externalUrl: 'https://old.com/1' },
        REPO,
      );
      const updated = await updateTask(task.id, { externalId: 'new#2', externalUrl: 'https://new.com/2' }, REPO);
      expect(updated).not.toBeNull();
      expect(updated!.externalId).toBe('new#2');
      expect(updated!.externalUrl).toBe('https://new.com/2');
    });

    it('should filter tasks by externalId', async () => {
      const extId = `filter-test-${Date.now()}`;
      await createTask({ title: 'Filtered task', externalId: extId, externalUrl: 'https://example.com' }, REPO);
      await createTask({ title: 'Other task' }, REPO);

      const filtered = await listTasks({ repoPath: REPO, externalId: extId });
      expect(filtered.length).toBe(1);
      expect(filtered[0].externalId).toBe(extId);
    });

    it('should show external fields in getTask()', async () => {
      const task = await createTask(
        { title: 'Detail check', externalId: 'detail#99', externalUrl: 'https://detail.com/99' },
        REPO,
      );
      const fetched = await getTask(task.id, REPO);
      expect(fetched).not.toBeNull();
      expect(fetched!.externalId).toBe('detail#99');
      expect(fetched!.externalUrl).toBe('https://detail.com/99');
    });
  });
});
