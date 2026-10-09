'use strict';

const VALID_REASONING_EFFORTS = new Set(['none', 'low', 'high', 'max']);

function normalizeThinkingType(value) {
    const raw = value && typeof value === 'object' ? value.type : value;

    if (raw === true) return 'enabled';
    if (raw === false) return 'disabled';

    const normalized = String(raw || '').trim().toLowerCase();
    if (['enabled', 'enable', 'on', 'true'].includes(normalized)) return 'enabled';
    if (['disabled', 'disable', 'off', 'false'].includes(normalized)) return 'disabled';
    return null;
}

function normalizeReasoningEffort(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (VALID_REASONING_EFFORTS.has(normalized)) return normalized;
    if (normalized === 'minimal') return 'low';
    if (normalized === 'medium') return 'high';
    return null;
}

function resolveDeepSeekThinking(body = {}, options = {}) {
    if (options.forceDisabled) {
        return {
            thinking: { type: 'disabled' },
            reasoning_effort: 'none'
        };
    }

    const requestedEffort = normalizeReasoningEffort(body.reasoning_effort);
    const requestedThinking = normalizeThinkingType(body.thinking);
    const defaultThinking = normalizeThinkingType(options.defaultThinking) || 'enabled';
    const defaultEffort = normalizeReasoningEffort(options.defaultEffort) || 'high';

    let type = requestedThinking;
    if (!type && requestedEffort) {
        type = requestedEffort === 'none' ? 'disabled' : 'enabled';
    }
    type ||= defaultThinking;

    return {
        thinking: { type },
        reasoning_effort: type === 'disabled'
            ? 'none'
            : (requestedEffort && requestedEffort !== 'none'
                ? requestedEffort
                : defaultEffort)
    };
}

function buildAssistantMessage(message, { includeToolCalls = false } = {}) {
    const result = {
        role: 'assistant',
        content: message?.content ?? null
    };

    if (typeof message?.reasoning_content === 'string') {
        result.reasoning_content = message.reasoning_content;
    }
    if (includeToolCalls && Array.isArray(message?.tool_calls)) {
        result.tool_calls = message.tool_calls;
    }

    return result;
}

function hasAssistantOutput(data) {
    const message = data?.choices?.[0]?.message;
    const content = typeof message?.content === 'string'
        ? message.content.trim()
        : message?.content;

    return Boolean(
        content ||
        (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) ||
        data?.reply || data?.result || data?.content || data?.output || data?.response
    );
}

module.exports = {
    buildAssistantMessage,
    hasAssistantOutput,
    normalizeReasoningEffort,
    normalizeThinkingType,
    resolveDeepSeekThinking
};
