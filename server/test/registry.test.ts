import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, fail, ok, type ToolDefinition } from '../src/tools/registry';

function tool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    async execute() {
      return ok(name);
    },
    ...extra
  };
}

test('register, get and list keep insertion order', () => {
  const registry = new ToolRegistry().register(tool('b')).register(tool('a'));
  assert.deepEqual(registry.list().map((t) => t.name), ['b', 'a']);
  assert.equal(registry.get('a')?.name, 'a');
  assert.equal(registry.get('missing'), undefined);
});

test('names must follow the function-calling rule', () => {
  const registry = new ToolRegistry();
  for (const bad of ['', 'has space', 'dots.too', 'x'.repeat(65)]) {
    assert.throws(() => registry.register(tool(bad)), /Invalid tool name/);
  }
  assert.doesNotThrow(() => registry.register(tool('ok_name-1')));
});

test('duplicate names are rejected', () => {
  const registry = new ToolRegistry().register(tool('dup'));
  assert.throws(() => registry.register(tool('dup')), /already registered/);
});

test('assemble emits the OpenAI tools array without destructive tools', () => {
  const registry = new ToolRegistry()
    .register(tool('safe', { description: 'A safe tool', parameters: { type: 'object', properties: { x: { type: 'number' } } } }))
    .register(tool('nuke', { destructive: true }));

  assert.deepEqual(registry.assemble(), [
    {
      type: 'function',
      function: {
        name: 'safe',
        description: 'A safe tool',
        parameters: { type: 'object', properties: { x: { type: 'number' } } }
      }
    }
  ]);
  assert.equal(registry.list().length, 2);
});

test('ok and fail build outcomes', () => {
  assert.deepEqual(ok('done'), { content: 'done', isError: false });
  assert.deepEqual(fail('nope', 'bad_input'), { content: 'nope', isError: true, errorType: 'bad_input' });
});
