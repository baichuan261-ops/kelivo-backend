const fs = require('fs');
const path = require('path');
const Module = require('module');

const gatewayPath = path.join(__dirname, 'memory-gateway.js');
let source = fs.readFileSync(gatewayPath, 'utf8');

function replaceOnce(needle, replacement, label) {
  const index = source.indexOf(needle);

  if (index === -1) {
    throw new Error(
      'Memory UI 注入失败：找不到代码位置 ' + label +
      '。memory-gateway.js 可能已经被修改，请重新核对版本。'
    );
  }

  source =
    source.slice(0, index) +
    replacement +
    source.slice(index + needle.length);
}

// ==================================================
// ① 每次聊天记录本轮成功执行过哪些记忆操作
// ==================================================

replaceOnce(
`async function handleChat(
  req,
  res
) {
  if (`,
`async function handleChat(
  req,
  res
) {
  const memoryNotices = new Set();

  function addMemoryNotice(name, result) {
    if (!result?.ok) {
      return;
    }

    if (name === 'read_memory') {
      memoryNotices.add('🧠 已读取长期记忆');
      return;
    }

    if (name === 'create_memory') {
      if (result.created) {
        memoryNotices.add('📝 已写入长期记忆');
      } else if (result.duplicate) {
        memoryNotices.add('📝 长期记忆已存在');
      }

      return;
    }

    if (
      name === 'edit_memory' ||
      name === 'update_memory'
    ) {
      if (result.updated) {
        memoryNotices.add('✏️ 已更新长期记忆');
      } else if (result.unchanged) {
        memoryNotices.add('✏️ 长期记忆无需更新');
      }

      return;
    }

    if (
      name === 'delete_memory' &&
      result.deleted
    ) {
      memoryNotices.add('🗑️ 已删除长期记忆');
    }
  }

  function applyMemoryNotices(payload) {
    if (
      !payload ||
      memoryNotices.size === 0
    ) {
      return payload;
    }

    const message =
      payload
        ?.choices?.[0]
        ?.message;

    if (!message) {
      return payload;
    }

    const noticeText =
      Array.from(
        memoryNotices
      ).join('\\n');

    const originalContent =
      typeof message.content === 'string'
        ? message.content.trim()
        : '';

    const mergedContent =
      originalContent
        ? noticeText +
          '\\n\\n' +
          originalContent
        : noticeText;

    message.content =
      mergedContent;

    payload.reply =
      mergedContent;

    return payload;
  }

  if (`,
  'handleChat-start'
);

// ==================================================
// ② Supabase 工具真的执行成功后记录状态
// ==================================================

replaceOnce(
`        result =
          await runMemoryTool(
            name,
            parseArgs(call),
            sessionId
          );

      } catch (e) {`,
`        result =
          await runMemoryTool(
            name,
            parseArgs(call),
            sessionId
          );

        addMemoryNotice(
          name,
          result
        );

      } catch (e) {`,
  'memory-tool-result'
);

// ==================================================
// ③ 正常最终回复返回 Kelivo 前显示状态
// ==================================================

replaceOnce(
`    if (
      !Array.isArray(calls) ||
      calls.length === 0
    ) {
      return res
        .status(
          inner.status
        )
        .json(
          inner.json
        );
    }`,
`    if (
      !Array.isArray(calls) ||
      calls.length === 0
    ) {
      applyMemoryNotices(
        inner.json
      );

      return res
        .status(
          inner.status
        )
        .json(
          inner.json
        );
    }`,
  'final-response'
);

// ==================================================
// ④ 如果记忆工具之后还要调用天气/手机等客户端工具，
// 也把记忆状态带给 Kelivo，避免提示被吞掉
// ==================================================

replaceOnce(
`    if (
      memoryCalls.length === 0
    ) {
      return res
        .status(
          inner.status
        )
        .json(
          inner.json
        );
    }`,
`    if (
      memoryCalls.length === 0
    ) {
      applyMemoryNotices(
        inner.json
      );

      return res
        .status(
          inner.status
        )
        .json(
          inner.json
        );
    }`,
  'client-tool-response'
);

console.log(
  '🎛️ Memory UI 状态提示已注入'
);

// ==================================================
// 不修改原 memory-gateway.js 文件。
// 直接把修改后的源码以内存方式运行。
// ==================================================

const virtualFilename =
  path.join(
    __dirname,
    'memory-gateway.runtime.js'
  );

const runtimeModule =
  new Module(
    virtualFilename,
    module
  );

runtimeModule.filename =
  virtualFilename;

runtimeModule.paths =
  Module._nodeModulePaths(
    __dirname
  );

runtimeModule._compile(
  source,
  virtualFilename
);
