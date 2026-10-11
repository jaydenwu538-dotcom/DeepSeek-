/**
 * DSH 插件：本地 Ollama 双模型串行协作。
 *
 * - 日常聊天 → qwen2.5:7b 直接回答
 * - 代码任务 → qwen2.5:7b 出详细实现指令 → 强制卸载 → deepseek-coder:6.7b 写代码 → 卸载
 * - 始终用中文回答
 * - 16GB 内存保护：每次调用 keep_alive:0，切模型前轮询 /api/ps 确认卸载
 */
import { Service } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';

interface StreamMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
}

interface StreamOptions {
  provider: string;
  model: string;
  messages: StreamMessage[];
  signal?: { aborted: boolean };
}

/** 代码任务关键词。 */
const CODE_KEYWORDS = [
  '写代码', '写函数', '写个函数', '编程', '代码', '脚本',
  'python', 'java', 'javascript', 'typescript', 'rust',
  'minecraft机器人', 'minecraft bot', 'mineflayer', 'mod开发',
  'function', 'debug', '报错', '异常', 'compile',
  '类', '接口', '实现', '算法', '斐波那契', '递归',
];

function isCodeTask(text: string): boolean {
  const lower = text.toLowerCase();
  return CODE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

const CHINESE_SYSTEM =
  '你是一个乐于助人的助手。请始终使用简体中文回答，即使问题用英文提出。代码注释也用中文。';

const ARCHITECT_SYSTEM =
  '你是一名资深软件架构师。把用户需求转译成一份结构化、无歧义、可直接交给另一个代码生成模型执行的"实现指令"。你不写最终代码，只写指令。用中文描述，但函数名、变量名、库名用英文。';

const CODER_SYSTEM =
  '你是一名资深 Python 工程师。严格按照实现指令写出完整、可直接运行的代码。只输出一个 fenced ```python 代码块，不要额外解释。包含 import、函数定义、必要的 main 示例。';

/** 把 coder 模型输出整理成规范的 ```python 围栏代码块。 */
function normalizeCodeBlock(raw: string): string {
  let text = raw.trim();
  // 已经有围栏就直接用
  if (text.startsWith('```')) return text;
  // 去掉开头孤零零的 "python" 语言标签
  text = text.replace(/^python\s*\n/, '').trim();
  // 修复被压成一行的缩进：冒号后 4+ 空格 + 关键字 → 换行
  text = text.replace(/:\s{4,}(?=(if|else|elif|for|while|try|except|with|return|def|class)\b)/g, ':\n    ');
  return '```python\n' + text + '\n```';
}

/** 调 Ollama /api/generate，非流式。 */
async function ollamaGenerate(
  host: string,
  model: string,
  prompt: string,
  system: string,
  temperature = 0.3,
): Promise<string> {
  const res = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      system,
      stream: false,
      keep_alive: 0,
      options: { temperature },
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { response?: string };
  return (data.response ?? '').trim();
}

/** 列出本機已安裝的 Ollama 模型名稱。 */
async function listInstalledModels(host: string): Promise<string[]> {
  try {
    const res = await fetch(`${host}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name ?? '');
  } catch {
    return [];
  }
}

/** 檢查某個模型是否已安裝（用前綴比對，容忍量化後綴差異）。 */
function modelInstalled(installed: string[], model: string): boolean {
  const base = model.split(':')[0] ?? model;
  return installed.some((n) => n === model || n.startsWith(base + ':'));
}

/** 强制卸载指定模型（发空请求 + keep_alive:0，再轮询 /api/ps 确认）。 */
async function forceUnload(host: string, model: string, timeoutMs = 10000): Promise<void> {
  await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 }),
  }).catch(() => {});

  const prefix = model.split(':')[0] ?? model;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${host}/api/ps`);
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      const loaded = (data.models ?? []).some((m) => (m.name ?? '').startsWith(prefix));
      if (!loaded) return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

class ChineseOllamaAdapter extends LlmAdapter {
  private readonly host: string;
  private readonly chatModel: string;
  private readonly coderModel: string;

  constructor(host: string, chatModel: string, coderModel: string) {
    super();
    this.host = host;
    this.chatModel = chatModel;
    this.coderModel = coderModel;
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Local Ollama (中文 + 双模型协作)' };
  }

  override listModels(provider: string) {
    return Promise.resolve([
      { provider, id: this.chatModel, name: this.chatModel + ' (中文对话)' },
      { provider, id: this.coderModel, name: this.coderModel + ' (代码生成)' },
    ]);
  }

  override async resolveModel(provider: string, model: string, _signal?: unknown) {
    return { provider, id: model, name: model, inputModalities: ['text'] as Array<'text'> };
  }

  async *stream(options: StreamOptions): AsyncGenerator<Record<string, unknown>> {
    // 取最後一條 user 訊息（v1.2.1 已驗證可行）
    let userText = '';
    for (let i = options.messages.length - 1; i >= 0; i--) {
      const m = options.messages[i]!;
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') { userText = m.content; break; }
      if (Array.isArray(m.content)) {
        userText = m.content.map((b) => b.text ?? '').join('\n').trim();
        break;
      }
    }

    let output: string;
    try {
      if (isCodeTask(userText)) {
        // ① 模型 A：qwen 出详细实现指令
        const spec = await ollamaGenerate(
          this.host, this.chatModel,
          [
            '请把以下用户需求转译成详细的代码实现指令：',
            '1. 给出函数名/类名（英文）。',
            '2. 列出输入参数（名称、类型、默认值）与返回值。',
            '3. 列出需要 import 的第三方库及 pip 包名。',
            '4. 用编号步骤写出实现逻辑，包含边界条件与异常分支。',
            '5. 不要写最终代码，只写指令。',
            '',
            '用户需求：',
            userText,
          ].join('\n'),
          ARCHITECT_SYSTEM,
          0.3,
        );

        // ② 卸载 qwen，确认释放
        await forceUnload(this.host, this.chatModel);

        // ③ 模型 B：deepseek-coder 写代码
        const code = await ollamaGenerate(
          this.host, this.coderModel,
          `根据以下实现指令，写出完整可运行的 Python 代码：\n\n"""\n${spec}\n"""`,
          CODER_SYSTEM,
          0.1,
        );

        // ④ 卸载 deepseek-coder
        await forceUnload(this.host, this.coderModel);

        output = [
          '【架构师指令（' + this.chatModel + '）】',
          spec,
          '',
          '【最终代码（' + this.coderModel + '）】',
          normalizeCodeBlock(code),
        ].join('\n');
      } else {
        // 日常聊天：直接 qwen 回答
        output = await ollamaGenerate(
          this.host, this.chatModel,
          `${CHINESE_SYSTEM}\n\n用户问题：${userText}`,
          CHINESE_SYSTEM,
          0.7,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('not found') || msg.includes('try pulling')) {
        const missing = msg.includes(this.coderModel.split(':')[0] ?? '') ? this.coderModel : this.chatModel;
        output = [
          `⚠️ 缺少本機模型：${missing}`,
          '',
          '請打開終端機執行以下指令下載：',
          `\`\`\`bash`,
          `ollama pull ${missing}`,
          `\`\`\``,
          '',
          '下載完成後重新發送訊息即可。',
        ].join('\n');
      } else if (msg.includes('Failed to fetch') || msg.includes('ECONNREFUSED')) {
        output = [
          '⚠️ 無法連接 Ollama。',
          '',
          '請確認 Ollama 已啟動：',
          '1. 打開 Ollama 桌面版或在終端執行 `ollama serve`',
          `2. 確認位址：${this.host}`,
        ].join('\n');
      } else {
        output = `[插件错误] ${msg}`;
      }
    }

    yield { type: 'text-delta', index: 0, text: output };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export class ChineseRouterService extends Service {
  static inject = ['llm'] as const;

  static Config = z.object({
    ollamaHost: z.string().default('http://localhost:11434'),
    chatModel: z.string().default('qwen2.5:7b-instruct-q4_K_M'),
    coderModel: z.string().default('deepseek-coder:6.7b'),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(ctx: any, config: { ollamaHost: string; chatModel: string; coderModel: string }) {
    super(ctx, 'chinese-router');
    ctx.llm.registerAdapter(
      ['ollama-local'],
      new ChineseOllamaAdapter(config.ollamaHost, config.chatModel, config.coderModel),
    );
    console.log(
      `[chinese-router] 已注册 ollama-local。聊天=${config.chatModel}，代码=${config.coderModel}。`,
    );
    // 啟動時偵測本機模型
    listInstalledModels(config.ollamaHost).then((installed) => {
      const chatOk = installed.some((n) => n === config.chatModel || n.startsWith(config.chatModel.split(':')[0] + ':'));
      const coderOk = installed.some((n) => n === config.coderModel || n.startsWith(config.coderModel.split(':')[0] + ':'));
      console.log(`[chinese-router] 本機已安裝模型: ${installed.join(', ') || '(無 / Ollama 未啟動)'}`);
      console.log(`[chinese-router] 對話模型 ${config.chatModel}: ${chatOk ? '✅ 已就緒' : '❌ 缺失'}`);
      console.log(`[chinese-router] 代碼模型 ${config.coderModel}: ${coderOk ? '✅ 已就緒' : '❌ 缺失'}`);
      if (!chatOk || !coderOk) {
        console.log('[chinese-router] 下載指令:');
        if (!chatOk) console.log(`  ollama pull ${config.chatModel}`);
        if (!coderOk) console.log(`  ollama pull ${config.coderModel}`);
      }
    });
  }
}

export default ChineseRouterService;
