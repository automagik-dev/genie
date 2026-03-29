import { describe, expect, test } from 'bun:test';
import { parseNotifyPayload } from './event-router.js';
import { type EventSubscriptionConfig, shouldRouteEvent } from './team-manager.js';

describe('shouldRouteEvent', () => {
  test('actionable preset routes task.comment', () => {
    const config: EventSubscriptionConfig = { preset: 'actionable' };
    expect(shouldRouteEvent(config, 'task.comment')).toBe(true);
  });

  test('actionable preset routes executor.error', () => {
    const config: EventSubscriptionConfig = { preset: 'actionable' };
    expect(shouldRouteEvent(config, 'executor.error')).toBe(true);
  });

  test('actionable preset does NOT route executor.state_change', () => {
    const config: EventSubscriptionConfig = { preset: 'actionable' };
    expect(shouldRouteEvent(config, 'executor.state_change')).toBe(false);
  });

  test('verbose preset routes executor.state_change', () => {
    const config: EventSubscriptionConfig = { preset: 'verbose' };
    expect(shouldRouteEvent(config, 'executor.state_change')).toBe(true);
  });

  test('verbose preset routes assignment.started', () => {
    const config: EventSubscriptionConfig = { preset: 'verbose' };
    expect(shouldRouteEvent(config, 'assignment.started')).toBe(true);
  });

  test('silent preset routes nothing', () => {
    const config: EventSubscriptionConfig = { preset: 'silent' };
    expect(shouldRouteEvent(config, 'task.comment')).toBe(false);
    expect(shouldRouteEvent(config, 'executor.error')).toBe(false);
    expect(shouldRouteEvent(config, 'executor.state_change')).toBe(false);
  });

  test('overrides take priority over preset', () => {
    const config: EventSubscriptionConfig = {
      preset: 'actionable',
      overrides: {
        'executor.state_change': true,
        'task.comment': false,
      },
    };
    // Override enables event not in preset
    expect(shouldRouteEvent(config, 'executor.state_change')).toBe(true);
    // Override disables event that IS in preset
    expect(shouldRouteEvent(config, 'task.comment')).toBe(false);
    // Non-overridden events follow preset
    expect(shouldRouteEvent(config, 'executor.error')).toBe(true);
  });

  test('silent preset with overrides can enable specific events', () => {
    const config: EventSubscriptionConfig = {
      preset: 'silent',
      overrides: { 'executor.error': true },
    };
    expect(shouldRouteEvent(config, 'executor.error')).toBe(true);
    expect(shouldRouteEvent(config, 'task.comment')).toBe(false);
  });
});

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

  test('parses genie_request pending as request.created', () => {
    const event = parseNotifyPayload('genie_request', 'req-1:eng-3:env:pending');
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe('request.created');
    expect(event!.agentId).toBe('eng-3');
  });

  test('parses genie_request resolved', () => {
    const event = parseNotifyPayload('genie_request', 'req-1:eng-3:env:resolved');
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe('request.resolved');
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
