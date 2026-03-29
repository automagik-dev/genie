import { describe, expect, test } from 'bun:test';
import { parseNotifyPayload } from './event-router.js';

describe('parseNotifyPayload', () => {
  test('parses genie_task_stage payload', () => {
    const event = parseNotifyPayload('genie_task_stage', 'task-123:build:review');
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe('task.stage_change');
    expect(event!.taskId).toBe('task-123');
    expect(event!.payload).toEqual({ taskId: 'task-123', fromStage: 'build', toStage: 'review' });
  });

  test('parses genie_executor_state payload', () => {
    const event = parseNotifyPayload('genie_executor_state', 'exec-1:agent-5:idle:working');
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe('executor.state_change');
    expect(event!.agentId).toBe('agent-5');
    expect(event!.payload.oldState).toBe('idle');
    expect(event!.payload.newState).toBe('working');
  });

  test('parses genie_executor_state error as executor.error', () => {
    const event = parseNotifyPayload('genie_executor_state', 'exec-1:agent-5:working:error');
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe('executor.error');
  });

  test('parses genie_message payload', () => {
    const event = parseNotifyPayload('genie_message', '42:conv-abc');
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe('task.comment');
    expect(event!.payload).toEqual({ messageId: '42', conversationId: 'conv-abc' });
  });

  test('returns null for unknown channel', () => {
    const event = parseNotifyPayload('unknown_channel', 'anything');
    expect(event).toBeNull();
  });

  test('returns null for malformed payload', () => {
    const event = parseNotifyPayload('genie_task_stage', 'only-one-part');
    expect(event).toBeNull();
  });
});
