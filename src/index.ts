/**
 * DSH (DeepSeek Harness) 插件入口：Cordis Service。
 *
 * 工作方式：
 *  1. 注册一个名为 `ollama-local` 的 LLM adapter（ctx.llm.registerAdapter）。
 *  2. 用户在 DSH 模型选择器里选 `ollama-local/qwen2.5:7b-instruct-q4_K_M`。
 *  3. 每次 DSH 调 LLM 时，本插件的 adapter.stream() 被调用：
 *     - 检查最后一条用户消息是否命中代码关键词；
 *     - 是 → 串行流程：qwen2.5:7b 出指令 → 强制卸载 → deepseek-coder:6.7b 出代码 → 卸载；
 *     - 否 → 直接用 qwen2.5:7b 回答。
 *  4. 输出转成 DSH 的 text-delta chunk 流，写回对话框。
 *
 * 内存保护：每次调用都 keep_alive:0，切模型前 ensureUnloaded 轮询 /api/ps。
 */
import { Service } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { runRouting, isCodeTask, type RouterConfig } from './router.js';

/** DSH 传给 adapter.stream() 的 options 形状（只取我们用得到的字段）。 */
interface StreamOptions {
  provider: string;
  model: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
  }>;
  signal?: { aborted: boolean };
}

/** 从 messages 里提取最后一条用户文本。 */
function lastUserText(messages: StreamOptions['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b) => b.text ?? '')
        .join('\n')
        .trim();
    }
  }
  return '';
}

/**
 * 本地 Ollama LLM adapter。
 * 继承 DSH 的 LlmAdapter，实现 stream() 把请求路由到 localhost:11434。
 */
class OllamaLocalAdapter extends LlmAdapter {
  private readonly cfg: RouterConfig;

  constructor(cfg: RouterConfig) {
    super();
    this.cfg = cfg;
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Local Ollama (16GB memory-safe)' };
  }

  override listModels(_provider: string) {
    return Promise.resolve([
      { id: this.cfg.chatModel, name: this.cfg.chatModel },
      { id: this.cfg.coderModel, name: this.cfg.coderModel },
    ]);
  }

  override async resolveModel(provider: string, model: string, _signal?: unknown) {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'] as Array<'text'>,
    };
  }

  /**
   * DSH 调用入口：返回一个 async generator，yield chunk。
   * chunk 形状见 dsh-llm：{ type: "text-delta", index, text }，结束时 { type: "finish", reason: { kind: "stop" } }。
   */
  async *stream(options: StreamOptions): AsyncGenerator<Record<string, unknown>> {
    const userText = lastUserText(options.messages);
    let output: string;
    try {
      output = await runRouting(userText, this.cfg);
    } catch (e) {
      output = `[model-router] ${e instanceof Error ? e.message : String(e)}`;
    }

    // 切成 chunks：简单起见整段作为一个 text-delta，index=0。
    yield { type: 'text-delta', index: 0, text: output };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export class ModelRouterService extends Service {
  static inject = ['llm'] as const;

  static Config = z.object({
    ollamaHost: z.string().default('http://localhost:11434'),
    chatModel: z.string().default('qwen2.5:7b-instruct-q4_K_M'),
    coderModel: z.string().default('deepseek-coder:6.7b'),
    unloadTimeoutMs: z.number().default(15000),
  });

  private readonly cfg: RouterConfig;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(ctx: any, config: RouterConfig) {
    super(ctx, 'model-router');
    this.cfg = config;

    // 注册本地 Ollama 为一个 LLM provider。
    // DSH 启动后，模型选择器里会出现 "ollama-local"。
    const adapter = new OllamaLocalAdapter(config);
    ctx.llm.registerAdapter(['ollama-local'], adapter);

    console.log(
      `[model-router] registered ollama-local provider. ` +
        `chat=${config.chatModel}, coder=${config.coderModel}. ` +
        `在模型选择器里选 ollama-local/${config.chatModel} 即可。`,
    );
  }
}

export default ModelRouterService;
