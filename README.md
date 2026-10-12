# Local Ollama 中文插件（DSH）

給 DeepSeek Harness 桌面版用的插件。裝完後，DSH 可以直接呼叫你本機 Ollama 裡的模型，而且**強制中文回答**。寫程式時還會自動走「千問出指令 → DeepSeek Coder 寫代碼」的兩段流程。

---

## 它能做什麼

| 你問的問題 | 插件怎麼處理 |
|---|---|
| 「今天天氣怎樣」「解釋一下什麼是閾值」 | 直接用 qwen2.5:7b 中文回答 |
| 「寫一個 Python 函數算斐波那契」 | ① qwen2.5:7b 先出中文實現指令 → 卸載 → ② deepseek-coder:6.7b 寫代碼 → 卸載 |
| 「幫我寫個 Minecraft 機器人」 | 同上，走雙模型流程 |

**記憶體保護**：兩個模型永遠不會同時駐留記憶體。每次切換都強制卸載上一個，超過 15 秒還沒卸乾淨就中止這次請求，避免 16GB 機器 OOM。

---

## 前置需求

1. 電腦上有 [Ollama](https://ollama.com) 在跑（預設 `http://localhost:11434`）
2. 已經拉好這兩個模型：
   ```bash
   ollama pull qwen2.5:7b-instruct-q4_K_M
   ollama pull deepseek-coder:6.7b
   ```
3. DSH 桌面版 0.2.0-rc.2 或以上

---

## 安裝

在 DSH 的「添加插件」視窗裡，貼上這個 GitHub 倉庫網址：

```
https://github.com/jaydenwu538-dotcom/dsh-ollama-cn
```

安裝完**完全結束 DSH 再重開**。

---

## 使用

1. 開新對話
2. 點對話框下方的模型選擇器
3. 選 **`Local Ollama (中文回答)`** 底下的 `qwen2.5:7b-instruct-q4_K_M (中文對話)`
4. 直接打問題就好

---

## 你會看到什麼

**日常聊天**：qwen 直接回中文。

**寫程式**：回覆會分兩段——

```
【架構師指令（qwen2.5:7b-instruct-q4_K_M）】
函數名：fibonacci
輸入參數：n (int)
實現邏輯：...

【最終代碼（deepseek-coder:6.7b）】
```python
def fibonacci(n):
    ...
```
```

---

## 常見問題

**Q：第一次發訊息回了「了解」或在講 skill 列表？**
A：那是 DSH 啟動時注入的系統提示，插件會自動略過。再發一次就好。

**Q：顯示「缺少本機模型」？**
A：照對話框裡的指令跑 `ollama pull <模型名>` 即可。

**Q：顯示「無法連接 Ollama」？**
A：確認 Ollama 有在跑（工作列有小燈，或終端機 `ollama serve`）。

**Q：寫程式時 15 秒還沒好？**
A：第一次載入模型會慢。如果顯示「記憶體釋放中，請重試」，等 5 秒再發一次。

---

## 進階設定（可選）

在 DSH 的插件設定裡可以改：

| 設定 | 預設值 | 說明 |
|---|---|---|
| `ollamaHost` | `http://localhost:11434` | Ollama 位置 |
| `chatModel` | `qwen2.5:7b-instruct-q4_K_M` | 對話/出指令的模型 |
| `coderModel` | `deepseek-coder:6.7b` | 寫代碼的模型 |
