/**
 * 最小插件：让本地 Ollama 模型始终用中文回答。
 *
 * 注册 `ollama-local` provider，用户在模型选择器选它即可。
 * adapter 每次调用都自动在系统提示里加"请始终用中文回答"。
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

const CHINESE_SYSTEM =
  '你是一个乐于助人的助手。请始终使用简体中文回答，即使问题用英文提出。代码注释也用中文。';

class ChineseOllamaAdapter extends LlmAdapter {
  private readonly host: string;
  private readonly model: string;

  constructor(host: string, model: string) {
    super();
    this.host = host;
    this.model = model;
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Local Ollama (中文回答)' };
  }

  override listModels(_provider: string) {
    return Promise.resolve([{ id: this.model, name: this.model + ' (中文)' }]);
  }

  override async resolveModel(provider: string, model: string, _signal?: unknown) {
    return { provider, id: model, name: model, inputModalities: ['text'] as Array<'text'> };
  }

  async *stream(options: StreamOptions): AsyncGenerator<Record<string, unknown>> {
    // 提取最后一条用户消息
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

    const prompt = `${CHINESE_SYSTEM}\n\n用户问题：${userText}`;

    let output: string;
    try {
      const res = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          keep_alive: 0,
          options: { temperature: 0.7 },
        }),
      });
      if (!res.ok) {
        output = `[插件错误] Ollama HTTP ${res.status}：${await res.text()}`;
      } else {
        const data = (await res.json()) as { response?: string };
        output = data.response ?? '(空回复)';
      }
    } catch (e) {
      output = `[插件错误] 无法连接 ${this.host}：${e instanceof Error ? e.message : String(e)}。请确认 Ollama 已启动。`;
    }

    yield { type: 'text-delta', index: 0, text: output };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export class ChineseRouterService extends Service {
  static inject = ['llm'] as const;

  static Config = z.object({
    ollamaHost: z.string().default('http://localhost:11434'),
    model: z.string().default('qwen2.5:7b-instruct-q4_K_M'),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(ctx: any, config: { ollamaHost: string; model: string }) {
    super(ctx, 'chinese-router');
    ctx.llm.registerAdapter(
      ['ollama-local'],
      new ChineseOllamaAdapter(config.ollamaHost, config.model),
    );
    console.log(
      `[chinese-router] 已注册 ollama-local，模型=${config.model}。在模型选择器里选它即可。`,
    );
  }
}

export default ChineseRouterService;
