const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolPrinciple, timePrinciple } = require('../conversation-principles');
const { buildHeartbeatMessages } = require('../proactive-core');

test('push history distinguishes delivery and does not treat silence as rejection', () => {
  const result = buildHeartbeatMessages({rows:[], memories:[], nowText:'now', characterName:'Silas', recentPushes:[
    {content:'历史未确认',source:'proactive',created_at:'2026-10-15T00:00:00Z'},
    {content:'已投递内容',source:'proactive_sent',created_at:'2026-10-16T00:00:00Z'}
  ]});
  assert.ok(result[0].content.includes('历史生成记录，是否投递未知'));
  assert.ok(result[0].content.includes('推送服务已接受，用户是否读过未知'));
  assert.ok(result[0].content.includes('不能单独作为持续不发送的理由'));
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(source.includes("source: 'in.(proactive,proactive_sent)'"));
});

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
