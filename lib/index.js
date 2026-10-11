/**
 * 最小插件：让本地 Ollama 模型始终用中文回答。
 *
 * 注册 `ollama-local` provider，用户在模型选择器选它即可。
 * adapter 每次调用都自动在系统提示里加"请始终用中文回答"。
 */
import { Service } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
const CHINESE_SYSTEM = '你是一个乐于助人的助手。请始终使用简体中文回答，即使问题用英文提出。代码注释也用中文。';
class ChineseOllamaAdapter extends LlmAdapter {
    host;
    model;
    constructor(host, model) {
        super();
        this.host = host;
        this.model = model;
    }
    providerInfo(provider) {
        return { id: provider, name: 'Local Ollama (中文回答)' };
    }
    listModels(provider) {
        return Promise.resolve([
            { provider, id: this.model, name: this.model + ' (中文)' },
        ]);
    }
    async resolveModel(provider, model, _signal) {
        return { provider, id: model, name: model, inputModalities: ['text'] };
    }
    async *stream(options) {
        // 提取最后一条用户消息
        let userText = '';
        for (let i = options.messages.length - 1; i >= 0; i--) {
            const m = options.messages[i];
            if (m.role !== 'user')
                continue;
            if (typeof m.content === 'string') {
                userText = m.content;
                break;
            }
            if (Array.isArray(m.content)) {
                userText = m.content.map((b) => b.text ?? '').join('\n').trim();
                break;
            }
        }
        const prompt = `${CHINESE_SYSTEM}\n\n用户问题：${userText}`;
        let output;
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
            }
            else {
                const data = (await res.json());
                output = data.response ?? '(空回复)';
            }
        }
        catch (e) {
            output = `[插件错误] 无法连接 ${this.host}：${e instanceof Error ? e.message : String(e)}。请确认 Ollama 已启动。`;
        }
        yield { type: 'text-delta', index: 0, text: output };
        yield { type: 'finish', reason: { kind: 'stop' } };
    }
}
export class ChineseRouterService extends Service {
    static inject = ['llm'];
    static Config = z.object({
        ollamaHost: z.string().default('http://localhost:11434'),
        model: z.string().default('qwen2.5:7b-instruct-q4_K_M'),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(ctx, config) {
        super(ctx, 'chinese-router');
        ctx.llm.registerAdapter(['ollama-local'], new ChineseOllamaAdapter(config.ollamaHost, config.model));
        console.log(`[chinese-router] 已注册 ollama-local，模型=${config.model}。在模型选择器里选它即可。`);
    }
}
export default ChineseRouterService;
//# sourceMappingURL=index.js.map