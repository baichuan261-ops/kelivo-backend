const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSchema, normalizeToolsForModel } = require('../tool-schema-compat');

test('actual MCP nullable arrays keep items, required fields, and tool metadata', () => {
    const tools = Array.from({ length: 42 }, (_, i) => ({ type: 'function', function: {
        name: `tool_${i}`, description: 'unchanged', parameters: {
            type: 'object', properties: Object.fromEntries(
                ['images', 'products', 'tags'].map(name => [name, {
                    type: ['null', 'array'], items: { type: 'string' }, description: name
                }])
            ), required: ['images'], additionalProperties: false
        }
    } }));
    const original = JSON.stringify(tools);
    const fixed = normalizeToolsForModel(tools, '[奶油-官混-0.02]gemini-3-flash-preview');
    assert.equal(fixed.length, 42);
    for (let i = 0; i < 42; i++) {
        assert.equal(fixed[i].function.name, tools[i].function.name);
        const p = fixed[i].function.parameters;
        assert.deepEqual(p.required, ['images']);
        assert.equal(p.additionalProperties, false);
        for (const name of ['images', 'products', 'tags']) {
            assert.deepEqual(p.properties[name], {
                type: 'array', nullable: true, items: { type: 'string' }, description: name
            });
        }
    }
    assert.equal(JSON.stringify(tools), original);
    assert.equal(normalizeToolsForModel(tools, 'deepseek-chat'), tools);
});

test('nested schemas normalized without rewriting example data or ambiguous unions', () => {
    const example = { type: ['null', 'array'], items: { type: 'string' } };
    const fixed = normalizeSchema({ type: 'array', items: {
        type: ['object', 'null'], properties: { type: { type: ['string', 'null'] } }
    }, default: example, anyOf: [{ type: ['array', 'null'], items: { type: 'integer' } }] });
    assert.equal(fixed.items.type, 'object');
    assert.equal(fixed.items.properties.type.type, 'string');
    assert.equal(fixed.anyOf[0].type, 'array');
    assert.deepEqual(fixed.default, example);
    assert.deepEqual(normalizeSchema({ type: ['string', 'number', 'null'] }).type, ['string', 'number', 'null']);
    assert.equal(normalizeSchema(false), false);
});
