# DeepSeek Harness Audio（Local Build）· 兩模型 Demo 快速上手（audio.2-pre32）

- **版本：** `0.1.5-rc.1-audio.2-pre32`，macOS Apple Silicon（arm64）。App 名稱：**DeepSeek Harness Audio pre32 (Local Build)**。
- **性質：** 依官方 DeepSeek Harness 0.1.5-rc.1 原始碼本機建置的**自訂版**，不是官方發行版。
- **簽章：** ad-hoc，**沒有** Developer ID 簽章、**沒有**公證。

**內建外掛（也可在 `plugins/` 單獨安裝）：**
- `dsh-dgx-audio` 0.4.12：vLLM／vLLM-Omni 音訊轉接（串流、Live 全雙工、playback ack、結束 Live 先停音、輪次模式標示）
- `dsh-voice-capture` 0.3.8：錄音、Live、邊收邊播、Stop 立即停止、Live 輪次模式二選一
- `dsh-audio-model-library` 0.1.6：**Audio models** 面板，只列兩個 Demo 模型；按 **Activate** 會在 DGX Spark 上切換模型
- `dsh-audio-release-kit` 0.3.7（系統提示說明預期使用者使用中文，不強制回答語言；語音對話開始後，你先說話模型才回答；啟動不再跳出「Internal Testing Notice」與「Add an API key」視窗；左側「Voice conversation / 语音对话」頁，一鍵全雙工通話；Stop reply 立刻停止，並在你說完下一句之前不讓模型自己接話；回答音訊有自動調整的播放緩衝，減少斷斷續續）：Audio servers 設定（DGX Spark 預設模型含正確請求設定：MiMo 回覆上限 200 tokens 與簡短系統提示、MiniCPM 關閉 thinking；已在 Audio models 設定 DGX 時，提示改用 Audio models）、DGX audio 模式

## 不用打字：第一次開啟就設定好
第一次開啟時，App 會把內建的 DGX Spark 預設值寫進 `~/.dsh/settings.yaml`，只補你還沒有的段落，**不會覆蓋你自己的設定**：
- Audio models 伺服器：DGX Spark `100.83.70.119`，透過你現有的 SSH 權限（`SBPLab@100.83.70.119`）使用 DGX 的模型切換控制器（不存密碼或金鑰）
- Demo 模型：MiniCPM-o 4.5、MiMo-Audio-7B-Instruct
- Live 語音提示檔：本機有實驗室檔案（`~/DSH/…`）時才設定，沒有就略過
- 新對話預設模型：MiniCPM-o 4.5（語音 → 文字 + 語音）

內容見 `examples/distribution-settings.dgx-spark.yaml`。刪掉某段之後，App 不會再自動加回。

## 目前狀態（誠實標示）
| 功能 | 狀態 |
|---|---|
| 啟動不跳出視窗（全新安裝） | 本版 PASS：從頁面開始載入就監看 40 秒，沒有任何對話框；同條件下 pre25 會先後跳出 2 個 |
| 語音對話頁（第 1 輪迭代） | **DGX 真機 MiniCPM-o 4.5 PASS**（audio.2-pre26，固定音檔，不是真麥克風）：接通 1.3 秒；英文問題說完約 3 秒開始回答且內容正確；中文問題有回答；Stop reply 69 毫秒停止。本版的 Stop reply（停止後等你開口）、播放緩衝：模擬伺服器 PASS（含舊版對照）；真機結果見下方「狀態」 |
| 預設值自動寫入（全新使用者資料夾） | 本版 dmg 驗證 PASS（全新安裝、重開、從舊版升級皆保留使用者設定） |
| **在 Harness 切換 DGX 模型** | audio.2-pre22 真機 PASS（同一組外掛；外掛除 release kit 外相同）：Audio models 按 Activate，按下到 Ready：MiniCPM → MiMo 4 分 49 秒；MiMo → MiniCPM 約 3 分 47 秒 |
| MiMo-Audio-7B-Instruct 麥克風問答 | audio.2-pre22 真機固定音檔 PASS（切換後）；內容正確性暫不驗 |
| MiniCPM-o 4.5 Live 全雙工 | audio.2-pre22 真機固定音檔 PASS（切換後，出聲中結束 Live 無殘音）；前版已知：原生全雙工第三段音檔後模型可能持續聆聽不回覆（模型行為） |
| 第二台實體 Mac | **未驗證** |

## 1. 安裝
1. 打開 dmg，把 **DeepSeek Harness Audio pre32 (Local Build)** 拖到「應用程式」。
2. 第一次開啟：在 Finder 中**按住 Control 點一下 → 打開**，或到「系統設定 → 隱私權與安全性」按**強制打開**。請勿關閉 Gatekeeper 或 SIP。
3. 可與其他 DeepSeek Harness 並存（獨立的 `~/.dsh/profiles/desktop-audio`）。

## 2. 使用
1. 開啟後直接進主畫面，不會跳出「Internal Testing Notice」或「Add an API key」視窗（音訊模型不需要 DeepSeek API key）。要用 DeepSeek 官方 API 時，到 **Settings → Models** 設定 key。
2. 左側按 **Audio models** → 右上 **Refresh**（第一次需要按一次，模型才會出現在選單）。
3. 要換模型：在 **Demo models** 找到模型，按 **Activate**。DGX 會先停掉目前的模型再載入新的，約 4–5 分鐘，畫面顯示每個步驟。
   - **注意：** 切換期間，任何正在用舊模型的人（包括其他電腦）都會暫時沒有回覆。
4. **New Session** → 選工作資料夾 → 模式 **DGX audio (no tools)** → 右下角選模型。
5. **麥克風問答：** 按 🎙 → 說話 → 停止 → **Send recording**。
6. **Live 全雙工（MiniCPM-o 4.5）：** 按 **Live** 開始說話；可按 **Interrupt** 打斷，按 **End** 結束。

## 3. 限制
- 在模型下拉選單選模型**不會**自動切換 DGX；要在 Audio models 按 **Activate**。
- 切換期間，另一個模型的使用者目前只會看到沒有回覆，還沒有「DGX 正在切換」提示（已提需求）。
- 只能在兩個 Demo 模型間切換（DGX 端授權範圍）。
- 使用 Audio models 切換需要能以 SSH 金鑰登入 `SBPLab@100.83.70.119`（不存密碼或金鑰）。
- **不要**在 Settings → Plugins → Audio servers 再手動加入 DGX Spark：Audio models 已提供同樣的模型。audio.2-pre23 以前的版本若手動加入，MiMo 回覆可能超過一分鐘不結束、MiniCPM 回覆以 `<think>` 開頭；已修正於本版。

## 回答語言
- 系統提示只說明「預期使用者會使用中文交談」，**不強制**回答語言（強制繁體中文會讓回覆語調不自然）。語音對話頁、以及新開的「DGX audio (no tools)」對話都適用。
- 用中文問通常以中文回答；用英文問，模型可能以英文回答；也可能出現簡體字（模型行為）。

## 第 1 輪迭代：語音對話頁（試用）
1. 左側「Audio models」按「Refresh」，確認 MiniCPM-o 4.5 已就緒。
2. 左側「Voice conversation」→ 選打斷方式 →「Start conversation」，直接說話，不需要錄音或送出。通話開始後模型會先聽，你說完第一句才回答（避免模型一開始就自己講話）。
3. 通話中可「Mute」、「Stop reply」、「End」；「Details」看傳送與延遲數據。
4. 目前只有聲音；通話紀錄存回對話、攝影機、MiMo 按住說話會在後續迭代加入。
5. 狀態：DGX 真機（固定音檔）已通過；真人麥克風、回音消除效果尚未驗證。按下 Stop reply 後畫面顯示「Waiting for you」，模型不會自己接話，你說完下一句後才繼續。已知：MiniCPM-o 4.5 在回答被取消後，會每隔幾秒自己開始說「So we…」之類的話；頁面不播放這些話，Details 會計數。
6. 「Details」會顯示：你說完到模型開口的時間、打斷到伺服器取消回答的時間、回答音訊斷續次數、目前播放緩衝、停止後被擋下的回答數。
