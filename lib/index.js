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
/** 代码任务关键词。 */
const CODE_KEYWORDS = [
    '写代码', '写函数', '写个函数', '编程', '代码', '脚本',
    'python', 'java', 'javascript', 'typescript', 'rust',
    'minecraft机器人', 'minecraft bot', 'mineflayer', 'mod开发',
    'function', 'debug', '报错', '异常', 'compile',
    '类', '接口', '实现', '算法', '斐波那契', '递归',
];
function isCodeTask(text) {
    const lower = text.toLowerCase();
    return CODE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}
const CHINESE_SYSTEM = '你是一个乐于助人的助手。请始终使用简体中文回答，即使问题用英文提出。代码注释也用中文。';
const ARCHITECT_SYSTEM = '你是一名资深软件架构师。把用户需求转译成一份结构化、无歧义、可直接交给另一个代码生成模型执行的"实现指令"。你不写最终代码，只写指令。用中文描述，但函数名、变量名、库名用英文。';
const CODER_SYSTEM = '你是一名资深 Python 工程师。严格按照实现指令写出完整、可直接运行的代码。只输出一个 fenced ```python 代码块，不要额外解释。包含 import、函数定义、必要的 main 示例。';
/** 调 Ollama /api/generate，非流式。 */
async function ollamaGenerate(host, model, prompt, system, temperature = 0.3) {
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
    const data = (await res.json());
    return (data.response ?? '').trim();
}
/** 强制卸载指定模型（发空请求 + keep_alive:0，再轮询 /api/ps 确认）。 */
async function forceUnload(host, model, timeoutMs = 10000) {
    await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 }),
    }).catch(() => { });
    const prefix = model.split(':')[0] ?? model;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${host}/api/ps`);
            const data = (await res.json());
            const loaded = (data.models ?? []).some((m) => (m.name ?? '').startsWith(prefix));
            if (!loaded)
                return;
        }
        catch {
            return;
        }
        await new Promise((r) => setTimeout(r, 400));
    }
}
class ChineseOllamaAdapter extends LlmAdapter {
    host;
    chatModel;
    coderModel;
    constructor(host, chatModel, coderModel) {
        super();
        this.host = host;
        this.chatModel = chatModel;
        this.coderModel = coderModel;
    }
    providerInfo(provider) {
        return { id: provider, name: 'Local Ollama (中文 + 双模型协作)' };
    }
    listModels(provider) {
        return Promise.resolve([
            { provider, id: this.chatModel, name: this.chatModel + ' (中文对话)' },
            { provider, id: this.coderModel, name: this.coderModel + ' (代码生成)' },
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
        let output;
        try {
            if (isCodeTask(userText)) {
                // ① 模型 A：qwen 出详细实现指令
                const spec = await ollamaGenerate(this.host, this.chatModel, [
                    '请把以下用户需求转译成详细的代码实现指令：',
                    '1. 给出函数名/类名（英文）。',
                    '2. 列出输入参数（名称、类型、默认值）与返回值。',
                    '3. 列出需要 import 的第三方库及 pip 包名。',
                    '4. 用编号步骤写出实现逻辑，包含边界条件与异常分支。',
                    '5. 不要写最终代码，只写指令。',
                    '',
                    '用户需求：',
                    userText,
                ].join('\n'), ARCHITECT_SYSTEM, 0.3);
                // ② 卸载 qwen，确认释放
                await forceUnload(this.host, this.chatModel);
                // ③ 模型 B：deepseek-coder 写代码
                const code = await ollamaGenerate(this.host, this.coderModel, `根据以下实现指令，写出完整可运行的 Python 代码：\n\n"""\n${spec}\n"""`, CODER_SYSTEM, 0.1);
                // ④ 卸载 deepseek-coder
                await forceUnload(this.host, this.coderModel);
                output = [
                    '【架构师指令（' + this.chatModel + '）】',
                    spec,
                    '',
                    '【最终代码（' + this.coderModel + '）】',
                    code,
                ].join('\n');
            }
            else {
                // 日常聊天：直接 qwen 回答
                output = await ollamaGenerate(this.host, this.chatModel, `${CHINESE_SYSTEM}\n\n用户问题：${userText}`, CHINESE_SYSTEM, 0.7);
            }
        }
        catch (e) {
            output = `[插件错误] ${e instanceof Error ? e.message : String(e)}`;
        }
        yield { type: 'text-delta', index: 0, text: output };
        yield { type: 'finish', reason: { kind: 'stop' } };
    }
}
export class ChineseRouterService extends Service {
    static inject = ['llm'];
    static Config = z.object({
        ollamaHost: z.string().default('http://localhost:11434'),
        chatModel: z.string().default('qwen2.5:7b-instruct-q4_K_M'),
        coderModel: z.string().default('deepseek-coder:6.7b'),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(ctx, config) {
        super(ctx, 'chinese-router');
        ctx.llm.registerAdapter(['ollama-local'], new ChineseOllamaAdapter(config.ollamaHost, config.chatModel, config.coderModel));
        console.log(`[chinese-router] 已注册 ollama-local。聊天=${config.chatModel}，代码=${config.coderModel}。`);
    }
}
export default ChineseRouterService;
//# sourceMappingURL=index.js.map