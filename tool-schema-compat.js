'use strict';

// Some OpenAI-to-Gemini gateways misread MCP's nullable type arrays.
// Traverse schema positions only: defaults/examples are user data, not schemas.
function normalizeSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
    const out = { ...schema };
    if (Array.isArray(schema.type)) {
        const nonNull = schema.type.filter(type => type !== 'null');
        if (nonNull.length === 1) {
            out.type = nonNull[0];
            if (schema.type.includes('null')) out.nullable = true;
        }
    }
    for (const key of ['properties', '$defs', 'definitions', 'patternProperties']) {
        if (schema[key] && typeof schema[key] === 'object') {
            out[key] = Object.fromEntries(Object.entries(schema[key]).map(
                ([name, value]) => [name, normalizeSchema(value)]
            ));
        }
    }
    for (const key of ['items', 'additionalProperties', 'contains', 'not']) {
        if (schema[key] !== undefined) out[key] = Array.isArray(schema[key])
            ? schema[key].map(normalizeSchema) : normalizeSchema(schema[key]);
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
        if (Array.isArray(schema[key])) out[key] = schema[key].map(normalizeSchema);
    }
    return out;
}

function normalizeToolsForModel(tools, model) {
    if (!/gemini/i.test(String(model))) return tools;
    return tools.map(tool => tool.type === 'function' && tool.function?.parameters
        ? { ...tool, function: { ...tool.function, parameters: normalizeSchema(tool.function.parameters) } }
        : tool);
}

module.exports = { normalizeSchema, normalizeToolsForModel };
