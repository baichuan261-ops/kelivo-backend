const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolPrinciple, timePrinciple } = require('../conversation-principles');
const { buildHeartbeatMessages } = require('../proactive-core');

test('chat includes approved principles without old restrictive tool rule', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(source.includes("require('./conversation-principles')"));
  assert.ok(source.includes("toolPrinciple + '\\n'"));
  assert.ok(source.includes("timePrinciple + '\\n'"));
  assert.ok(!source.includes('只有用户明确询问实时信息'));
  assert.ok(toolPrinciple.includes('不能用口头承诺或动作描写替代'));
});

test('cron includes time awareness without changing history timestamps or content', () => {
  const content = '[2026-10-16 10:00] 今天有课';
  const result = buildHeartbeatMessages({ rows: [{ role: 'user', content }], memories: [], nowText: '2026-10-16 12:00', characterName: 'Silas' });
  assert.ok(result[0].content.includes(timePrinciple));
  assert.ok(!result[0].content.includes(toolPrinciple));
  assert.equal(result[1].content, content);
});
