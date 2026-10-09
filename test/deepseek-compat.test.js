'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildAssistantMessage,
    buildToolContinuationMessage,
    hasAssistantOutput,
    resolveDeepSeekThinking,
    resolveToolContinuationEffort
} = require('../deepseek-compat');

test('DeepSeek thinking defaults to enabled and remains optional', () => {
    assert.deepEqual(resolveDeepSeekThinking({}), {
        thinking: { type: 'enabled' },
        reasoning_effort: 'high'
    });
    assert.deepEqual(resolveDeepSeekThinking({ thinking: { type: 'disabled' } }), {
        thinking: { type: 'disabled' },
        reasoning_effort: 'none'
    });
    assert.deepEqual(resolveDeepSeekThinking({ reasoning_effort: 'low' }), {
        thinking: { type: 'enabled' },
        reasoning_effort: 'low'
    });
});

test('empty-response recovery can force a non-thinking retry', () => {
    assert.deepEqual(
        resolveDeepSeekThinking(
            { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
            { forceDisabled: true }
        ),
        {
            thinking: { type: 'disabled' },
            reasoning_effort: 'none'
        }
    );
});

test('reasoning-only responses are empty, but tool calls are valid output', () => {
    assert.equal(hasAssistantOutput({
        choices: [{ message: { content: '', reasoning_content: 'private thought' } }]
    }), false);
    assert.equal(hasAssistantOutput({
        choices: [{ message: { content: null, tool_calls: [{ id: 'call_1' }] } }]
    }), true);
});

test('assistant responses preserve reasoning_content for tool continuation', () => {
    const message = buildAssistantMessage({
        content: null,
        reasoning_content: 'reasoning state',
        tool_calls: [{ id: 'call_1', type: 'function' }]
    }, { includeToolCalls: true });

    assert.deepEqual(message, {
        role: 'assistant',
        content: null,
        reasoning_content: 'reasoning state',
        tool_calls: [{ id: 'call_1', type: 'function' }]
    });
});

test('memory gateway continuation preserves reasoning and only selected calls', () => {
    const memoryCall = {
        id: 'memory_1',
        type: 'function',
        function: { name: 'read_memory', arguments: '{}' }
    };
    const clientCall = {
        id: 'client_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{}' }
    };

    const message = buildToolContinuationMessage({
        content: null,
        reasoning_content: 'reasoning state required by DeepSeek',
        tool_calls: [memoryCall, clientCall]
    }, [memoryCall]);

    assert.deepEqual(message, {
        role: 'assistant',
        content: null,
        reasoning_content: 'reasoning state required by DeepSeek',
        tool_calls: [memoryCall]
    });
});

test('memory tool continuation is fast by default but honors explicit effort', () => {
    assert.equal(resolveToolContinuationEffort(undefined), 'low');
    assert.equal(resolveToolContinuationEffort('high'), 'high');
    assert.equal(resolveToolContinuationEffort('max'), 'max');
    assert.equal(resolveToolContinuationEffort('medium'), 'high');
});
