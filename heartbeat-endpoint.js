'use strict';

function heartbeatEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const url = new URL(raw);
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname === '' || pathname === '/v1') {
    url.pathname = '/v1/chat/completions';
  }
  return url.toString();
}

module.exports = { heartbeatEndpoint };
