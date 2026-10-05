'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHeartbeatMessages,
  parseDecision,
  pushGapHoursForLocalHour,
  shouldSkipForCooldown
} = require('../proactive-core');

test('parseDecision accepts strict and fenced JSON', () => {
  assert.deepEqual(parseDecision('{"send":false,"reason":"没必要"}'), {
    send: false, reason: '没必要'
  });
  assert.equal(parseDecision('```json\n{"send":true,"title":"想你","message":"到家了吗？"}\n```').message, '到家了吗？');
});

test('parseDecision fails closed on prose or missing message', () => {
  assert.equal(parseDecision('我觉得应该发').send, false);
  assert.equal(parseDecision('{"send":true}').send, false);
});

test('cooldown uses newest assistant timestamp', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const rows = [{ role: 'assistant', created_at: '2026-10-05T10:30:00Z' }];
  assert.equal(shouldSkipForCooldown(rows, 3, now).skip, true);
  assert.equal(shouldSkipForCooldown(rows, 1, now).skip, false);
});

test('heartbeat context restores chronological order', () => {
  const messages = buildHeartbeatMessages({
    rows: [
      { role: 'assistant', content: '后说' },
      { role: 'user', content: '先说' }
    ],
    memories: [],
    nowText: '现在',
    characterName: '沈凛'
  });
  assert.deepEqual(messages.slice(1).map(item => item.content), ['先说', '后说']);
});

test('night push window uses two-hour gap from 02:00 through 07:59', () => {
  assert.equal(pushGapHoursForLocalHour(1), 0);
  assert.equal(pushGapHoursForLocalHour(2), 2);
  assert.equal(pushGapHoursForLocalHour(7), 2);
  assert.equal(pushGapHoursForLocalHour(8), 0);
});
