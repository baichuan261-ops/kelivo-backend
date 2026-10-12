'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('chat keeps newly stated and changed locations beyond the database row cap', async () => {
  let handler;
  const app = { use() {}, get() {}, post(path, fn) { handler = fn; }, listen() { return {}; } };
  const express = () => app;
  express.json = () => () => {};
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    id: i + 1, role: i % 2 ? 'assistant' : 'user', content: `old ${i}`,
    created_at: new Date(Date.now() - 86400000 + i * 1000).toISOString()
  }));
  const prompts = [];
  const queries = [];
  const sandbox = {
    require(name) { return name === 'express' ? express : require('../deepseek-compat'); },
    process: { env: { SUPABASE_URL: 'https://db.test', SUPABASE_KEY: 'test', CLIENT_API_KEY: 'test', TRANSFER_API_URL: 'https://model.test/chat', TRANSFER_API_KEY: 'test' } },
    console: { log() {} }, Buffer, URL, URLSearchParams, AbortSignal, AbortController,
    setTimeout, clearTimeout,
    async fetch(url, options = {}) {
      const parsed = new URL(url);
      if (parsed.hostname === 'model.test') {
        prompts.push(JSON.parse(options.body).messages);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }] }) };
      }
      if (options.method === 'POST') {
        if (parsed.pathname.endsWith('/messages')) rows.push({ ...JSON.parse(options.body), id: rows.length + 1, created_at: new Date(Date.now() + rows.length).toISOString() });
        return { ok: true };
      }
      queries.push(parsed);
      let data = parsed.pathname.endsWith('/memories') ? [] : rows.slice();
      if (parsed.searchParams.get('order')?.startsWith('created_at.desc')) data.reverse();
      data = data.slice(0, Math.min(1000, Number(parsed.searchParams.get('limit') || 1000)));
      return { ok: true, json: async () => data };
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../server.js'), 'utf8'), sandbox);
  for (const text of ['我在教室上课', '今天的作业好多', '我下课回宿舍了', '我现在在哪？']) {
    const req = new EventEmitter();
    Object.assign(req, { headers: { 'x-api-key': 'test' }, body: { messages: [{ role: 'user', content: text }] } });
    const res = new EventEmitter();
    res.status = () => res;
    res.json = body => { assert.ok(body.choices, JSON.stringify(body)); };
    await handler(req, res);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(prompts[1].some(m => m.content === '我在教室上课'));
  assert.ok(prompts[3].some(m => m.content === '我下课回宿舍了'));
  assert.equal(prompts[3].filter(m => m.content === '我现在在哪？').length, 1);
  assert.ok(prompts[3].findIndex(m => m.content === '我在教室上课') < prompts[3].findIndex(m => m.content === '我下课回宿舍了'));
  assert.ok(queries.filter(q => q.pathname.endsWith('/messages')).every(q => q.searchParams.get('order') === 'created_at.desc,id.desc' && q.searchParams.get('limit') === '149'));
});
