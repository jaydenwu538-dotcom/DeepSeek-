/**
 * 意图识别 + 双模型串行协作管线（纯函数，不依赖 Cordis）。
 *
 * 输入用户原文，输出要回给会话的字符串。
 * 内存保护逻辑全部在 ollama.ts 的 ensureUnloaded 闸门里。
 */

import { ensureUnloaded, generate, ollamaIsReachable } from './ollama.js';

export interface RouterConfig {
  ollamaHost: string;
  chatModel: string;
  coderModel: string;
  unloadTimeoutMs: number;
}

const CODE_KEYWORDS: ReadonlyArray<string> = [
  '写代码', '写函数', '写个函数', '编程', '代码', '脚本',
  'python', 'java', 'javascript', 'typescript', 'rust', 'go ',
  'minecraft机器人', 'minecraft bot', 'mineflayer', 'mod开发', '模组开发',
  'function', 'debug', '报错', '异常', 'exception', 'compile',
  '类', '接口', 'api', '实现', '算法',
];

export function isCodeTask(input: string): boolean {
  const lower = input.toLowerCase();
  return CODE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

async function runChat(userInput: string, cfg: RouterConfig): Promise<string> {
  return generate(cfg.ollamaHost, {
    model: cfg.chatModel,
    prompt: userInput,
    system: '你是一个简洁、乐于助人的中文助手。',
    temperature: 0.7,
  });
}

async function runCodeTask(userInput: string, cfg: RouterConfig): Promise<string> {
  // ① 模型 A：qwen2.5:7b 把原始需求转译成详细实现指令
  const spec = await generate(cfg.ollamaHost, {
    model: cfg.chatModel,
    temperature: 0.3,
    system:
      '你是一名资深软件架构师。你的唯一任务是把用户需求转译成一份' +
      '结构化、无歧义、可直接交给另一个代码生成模型执行的"实现指令"。你不写最终代码。',
    prompt: [
      '请把下面的用户需求转译成极其详细的代码实现指令：',
      '1. 给出函数名 / 类名（英文 snake_case 或 PascalCase）。',
      '2. 逐个列出输入参数（名称、类型、含义、默认值）与返回值。',
      '3. 列出需要 import 的第三方库并写出 pip 包名。',
      '4. 用编号步骤写出具体实现逻辑，包含边界条件与异常分支。',
      '5. 指出需要处理的错误输入 / 网络异常 / 空值情况。',
      '6. 指令用中文描述，但标识符、库名、类型名用英文。',
      '7. 不要给出最终代码，只给指令。',
      '',
      '用户原始需求：',
      '"""',
      userInput,
      '"""',
    ].join('\n'),
  });

  // ② 内存卸载闸门：确认模型 A 已释放，再加载模型 B
  await ensureUnloaded(cfg.ollamaHost, cfg.chatModel, cfg.unloadTimeoutMs);

  // ③ 模型 B：deepseek-coder:6.7b 写出最终 Python 代码
  const code = await generate(cfg.ollamaHost, {
    model: cfg.coderModel,
    temperature: 0.1,
    system:
      'You are an expert Python engineer. Output ONLY a single fenced ```python code block. ' +
      'No prose, no explanation. Include all imports, a runnable function/class, and a small ' +
      '`if __name__ == "__main__":` demo.',
    prompt: ['根据以下实现指令，写出完整、可直接运行的 Python 代码：', '', '"""', spec, '"""'].join('\n'),
  });

  // ④ 卸载模型 B（失败只警告，不影响本次结果）
  await ensureUnloaded(cfg.ollamaHost, cfg.coderModel, cfg.unloadTimeoutMs).catch(() => {});

  return [
    '【架构师指令（' + cfg.chatModel + '）】',
    spec,
    '',
    '【最终代码（' + cfg.coderModel + '）】',
    code,
  ].join('\n');
}

/** 插件主入口：判断意图 → 路由 → 返回要写回会话的字符串。 */
export async function runRouting(userInput: string, cfg: RouterConfig): Promise<string> {
  const text = userInput.trim();
  if (!text) return '';

  if (!(await ollamaIsReachable(cfg.ollamaHost))) {
    return (
      `[model-router] 检测不到 Ollama 服务（${cfg.ollamaHost}）。\n` +
      `请先启动 Ollama，并执行：ollama pull ${cfg.chatModel} 与 ollama pull ${cfg.coderModel}`
    );
  }

  if (isCodeTask(text)) {
    return runCodeTask(text, cfg);
  }
  return runChat(text, cfg);
}
