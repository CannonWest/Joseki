import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigin } from '../src/origin';

test('a page served from this server is allowed, however the server was reached', () => {
  assert.equal(allowedOrigin('http://localhost:3001', 'localhost:3001'), true);
  assert.equal(allowedOrigin('http://127.0.0.1:3001', '127.0.0.1:3001'), true);
  // Behind a tunnel that passes Host through: default port on both sides.
  assert.equal(allowedOrigin('https://joseki.example.com', 'joseki.example.com'), true);
});

test('a Host header in capitals still matches', () => {
  assert.equal(allowedOrigin('https://joseki.example.com', 'Joseki.Example.com'), true);
});

test('somebody else\'s page is refused', () => {
  assert.equal(allowedOrigin('https://evil.example', 'joseki.example.com'), false);
  // Same host, different port: a different origin.
  assert.equal(allowedOrigin('http://localhost:5173', 'localhost:3001'), false);
});

test('the scheme is not compared: a tunnel ends TLS before the request arrives', () => {
  // The page is https, the server is reached over plain http, and Host is
  // all the two have in common.
  assert.equal(allowedOrigin('https://localhost:3001', 'localhost:3001'), true);
});

test('an origin listed as extra is allowed from anywhere', () => {
  assert.equal(allowedOrigin('http://localhost:5173', 'localhost:3001', ['http://localhost:5173']), true);
  assert.equal(allowedOrigin('http://localhost:5174', 'localhost:3001', ['http://localhost:5173']), false);
});

test('no Origin is allowed: a non-browser client, or a same-origin request', () => {
  assert.equal(allowedOrigin(undefined, 'localhost:3001'), true);
  assert.equal(allowedOrigin('', 'localhost:3001'), true);
});

test('an opaque or unreadable origin is refused', () => {
  assert.equal(allowedOrigin('null', 'localhost:3001'), false);
  assert.equal(allowedOrigin('not a url', 'localhost:3001'), false);
});

test('an Origin with no Host to compare against is refused unless listed', () => {
  assert.equal(allowedOrigin('https://joseki.example.com', undefined), false);
  assert.equal(allowedOrigin('http://localhost:5173', undefined, ['http://localhost:5173']), true);
});
