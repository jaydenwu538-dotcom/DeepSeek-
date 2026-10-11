/**
 * Ollama 客户端 + 内存保护闸门。
 *
 * 16GB 内存硬约束：
 *  - 每次 /api/generate 都带 keep_alive: 0，响应返回后立即卸载。
 *  - 切模型前走 ensureUnloaded()：再发一次空 prompt + keep_alive: 0，
 *    并轮询 /api/ps 确认上一个模型真的不在内存里了，才允许发下一个请求。
 *  - 超时仍没卸载 → 抛错中止，物理上杜绝两个模型同时驻留。
 */
export async function ollamaIsReachable(host) {
    try {
        const res = await fetch(`${host}/api/tags`, { method: 'GET' });
        return res.ok;
    }
    catch {
        return false;
    }
}
export async function listLoadedModels(host) {
    try {
        const res = await fetch(`${host}/api/ps`, { method: 'GET' });
        if (!res.ok)
            return [];
        const data = (await res.json());
        return (data.models ?? [])
            .map((m) => m.name ?? m.model ?? '')
            .filter(Boolean);
    }
    catch {
        return [];
    }
}
export async function forceUnloadModel(host, model) {
    await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 }),
    }).catch(() => { });
}
export async function waitForUnload(host, model, timeoutMs) {
    const prefix = model.split(':')[0] ?? model;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const loaded = await listLoadedModels(host);
        const stillLoaded = loaded.some((m) => m.startsWith(prefix));
        if (!stillLoaded)
            return true;
        await new Promise((r) => setTimeout(r, 400));
    }
    return false;
}
export async function generate(host, opts) {
    const res = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: opts.model,
            prompt: opts.prompt,
            system: opts.system ?? '',
            stream: false,
            keep_alive: 0,
            options: { temperature: opts.temperature ?? 0.2 },
        }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (res.status === 404) {
            throw new Error(`模型 "${opts.model}" 不存在，请先执行：ollama pull ${opts.model}`);
        }
        throw new Error(`Ollama HTTP ${res.status} 调用 ${opts.model} 失败：${detail || res.statusText}`);
    }
    const data = (await res.json());
    if (data.error)
        throw new Error(`Ollama 返回错误：${data.error}`);
    return (data.response ?? '').trim();
}
/** 切模型前必须调用的闸门。 */
export async function ensureUnloaded(host, previousModel, timeoutMs) {
    await forceUnloadModel(host, previousModel);
    const ok = await waitForUnload(host, previousModel, timeoutMs);
    if (!ok) {
        throw new Error(`等待模型 ${previousModel} 卸载超时。为保护 16GB 内存已中止后续调用。` +
            `可手动执行：ollama stop ${previousModel}`);
    }
}
//# sourceMappingURL=ollama.js.map