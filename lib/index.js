/**
 * DSH (DeepSeek Harness) 插件入口：Cordis Service。
 *
 * 安装后 cordis.patch.yml 会把 `model-router` 这一层插进服务树，
 * Cordis 加载本包默认导出（ModelRouterService）并按 static Config 注入配置。
 *
 * 工作方式：监听 session/event，识别用户输入事件，交给 router.ts 跑
 * 本地 Ollama 管线，再把结果作为助手消息写回会话。
 */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { runRouting } from './router.js';
/**
 * DSH 会话事件里 user 侧事件的可能 type 名。
 * 桌宠插件观察的是 assistant/* / tool/* 事件；user 侧按对称命名，
 * 这里把常见候选都列上，命中任意一个即处理。装上后看一次
 * DSH 启动日志或事件调试器，把不命中的删掉即可。
 */
const USER_EVENT_TYPES = new Set([
    'user/message',
    'user/input',
    'session/user',
    'message/user',
    'human/message',
]);
export class ModelRouterService extends Service {
    /** 本插件不依赖 DSH 内部服务，直接走 Ollama HTTP，故 inject 为空。 */
    static inject = [];
    /** schemastery 配置；可在 cordis.patch.yml 的 config 块里覆盖。 */
    static Config = z.object({
        ollamaHost: z.string().default('http://localhost:11434'),
        chatModel: z.string().default('qwen2.5:7b'),
        coderModel: z.string().default('deepseek-coder:6.7b'),
        unloadTimeoutMs: z.number().default(15000),
    });
    cfg;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(ctx, config) {
        super(ctx, 'model-router');
        this.cfg = config;
        ctx.on('session/event', async (session, event) => {
            if (!USER_EVENT_TYPES.has(event.type))
                return;
            const text = extractUserText(event.data);
            if (!text)
                return;
            let reply;
            try {
                reply = await runRouting(text, this.cfg);
            }
            catch (e) {
                reply = `[model-router] ${e instanceof Error ? e.message : String(e)}`;
            }
            await injectAssistantReply(session, reply);
        });
    }
}
function extractUserText(data) {
    if (!data)
        return '';
    if (typeof data.text === 'string')
        return data.text;
    if (typeof data.message === 'string')
        return data.message;
    if (typeof data.content === 'string')
        return data.content;
    if (Array.isArray(data.blocks)) {
        return data.blocks
            .map((b) => b.text ?? '')
            .join('\n')
            .trim();
    }
    return '';
}
/**
 * 把助手回复写回会话。
 *
 * DSH 不同 rc 线写回助手消息的入口略有差异；这里按 Cordis 会话对象
 * 上常见的方法名依次尝试。装到 DSH 后如果回复没出现在对话框，
 * 在这一个函数里打个 console.log(session) 看真实形状，改成对应调用即可。
 * 其余逻辑（路由、内存卸载）不需要动。
 */
async function injectAssistantReply(session, text) {
    const s = session;
    if (!s)
        return;
    // 候选 1：session.reply(text)
    if (typeof s['reply'] === 'function') {
        await s['reply'].call(s, text);
        return;
    }
    // 候选 2：session.assistant?.say(text)
    const assistant = s['assistant'];
    if (assistant && typeof assistant['say'] === 'function') {
        await assistant['say'].call(assistant, text);
        return;
    }
    // 候选 3：session.emit('assistant/message', { content: text })
    if (typeof s['emit'] === 'function') {
        s['emit'].call(s, 'assistant/message', { content: text });
        return;
    }
    // 兜底：只打日志，不崩宿主。
    console.warn('[model-router] 未能写回会话（未找到 reply/say/emit 方法）：', text);
}
export default ModelRouterService;
//# sourceMappingURL=index.js.map