const test = require('node:test');
const assert = require('node:assert/strict');
const { heartbeatEndpoint } = require('../heartbeat-endpoint');

test('expands bare API bases without duplicating complete endpoints', () => {
  for (const base of ['https://example.com', 'https://example.com/', 'https://example.com/v1', ' https://example.com/v1/ ']) {
    assert.equal(heartbeatEndpoint(base), 'https://example.com/v1/chat/completions');
  }
  for (const url of ['https://example.com/v1/chat/completions', 'https://example.com/chat/completions', 'https://example.com/custom?version=1']) {
    assert.equal(heartbeatEndpoint(url), url);
  }
  assert.equal(heartbeatEndpoint(''), '');
});
