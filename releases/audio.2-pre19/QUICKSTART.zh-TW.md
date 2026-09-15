# DeepSeek Harness Audio（Local Build）· 兩模型 Demo 快速上手（audio.2-pre19）

- **版本：** `0.1.5-rc.1-audio.2-pre19`，macOS Apple Silicon（arm64）。
- **性質：** 依官方 DeepSeek Harness 0.1.5-rc.1 原始碼本機建置的**自訂版**，不是官方發行版。
- **簽章：** ad-hoc，**沒有** Developer ID 簽章、**沒有**公證。

**內建外掛（也可在 `plugins/` 單獨安裝）：**
- `dsh-dgx-audio` 0.4.12：vLLM／vLLM-Omni 音訊轉接（串流證據、Live 全雙工標示、playback ack；結束 Live 時先停止回覆音訊；記錄模型說話／聆聽決策；標示實際輪次模式「模型自行決定（原生全雙工）」或「伺服器 VAD」；伺服器會拒絕的輪次設定組合在連線前即明確拒絕）
- `dsh-voice-capture` 0.3.8：錄音、Live、邊收邊播與實際播放時間線、Stop 立即停止；Live 先取得麥克風權限才建立會話；按「結束 Live」立即停止本機播放；Live 輪次模式二選一（原生全雙工：模型自行決定何時說話／伺服器 VAD：說話可打斷回覆），面板顯示實際執行的模式
- `dsh-audio-model-library` 0.1.4：Audio models 面板
- `dsh-audio-release-kit` 0.2.2：Audio servers 設定、DGX audio 模式

## 目前狀態（誠實標示）
| 功能 | 狀態 |
|---|---|
| App、左側 **Audio models**、錄音 🎙、**Live**、模型下拉選單 | 可見 |
| 麥克風錄音、停止、預聽、送出 | 前一版（pre16）真 USB 麥克風錄現場聲音送出 MiMo 成功（內容正確性暫不驗） |
| MiniCPM-o 4.5 Live 全雙工 | 前一版（pre18）真機固定音檔：原生全雙工模式下輸出播放中送入的音訊被即時接收 PASS、Interrupt PASS、結束 Live 8 ms 內靜音 PASS；**第三段音檔後模型選擇持續聆聽未回覆（FAIL，模型行為，非外掛缺陷）**；伺服器 VAD 輪流模式每段音檔後皆有回覆 PASS（本版可在介面選擇「伺服器 VAD」模式；真機待驗） |
| MiMo-Audio-7B-Instruct | 前一版（pre17）真機固定音檔：傳輸 PASS、送出音訊與固定檔相關 0.9997、邊收邊播 PASS、**正在出聲時按 Stop** PASS（8 ms 中止）；內容正確性暫不驗 |
| 第二台實體 Mac | **未驗證** |

## 1. 安裝
1. 打開 dmg，把 **DeepSeek Harness Audio (Local Build)** 拖到「應用程式」。
2. 第一次開啟：在 Finder 中**按住 Control 點一下 → 打開**，或到「系統設定 → 隱私權與安全性」按**強制打開**。請勿關閉 Gatekeeper 或 SIP。
3. 可與其他 DeepSeek Harness 並存：使用獨立的 `~/.dsh/profiles/desktop-audio` 與 App 資料夾。`~/.dsh/settings.yaml` 共用；本版只新增 `dsh-dgx-audio` 段落。

## 2. 設定 DGX 端點（向 DGX 管理者索取位址）
- **語音問答模型：** **Settings → Plugins → Audio servers → Add audio server**：
  - Server address：`http://<DGX 位址>:18124/v1`
  - Model：`openbmb/MiniCPM-o-4_5`
  - 勾選 Ask for spoken replies
  - 伺服器要金鑰時，只填環境變數名稱，不填金鑰本身
- **Live 全雙工：** 需要 `mode: realtime` 模型與一段你有權使用的語音提示檔（`refAudioFile`）。按 **Open configuration file**，參考 `examples/settings.example.yaml`。
- **Test connection** 只讀模型清單，不做推論。

## 3. 使用
1. **New Session** → 選工作資料夾 → 模式選 **DGX audio (no tools)**。
2. 右下角選 **MiniCPM-o 4.5 · voice/mic question → text + spoken reply**。
3. **麥克風問答：**
   1. 按 🎙。第一次會出現 macOS 麥克風權限，按允許。
   2. 說話，按停止，預聽。
   3. 按 **Send recording**，應看到文字，並可播放語音回覆。
4. **Live 全雙工：**
   1. 按 **Live**，開始說話。
   2. 回覆會在你說話時出現。可按 **Interrupt** 打斷，按 **End input**／**Close** 結束。
5. `examples/jfk-inaugural-1961-public-domain-16k.wav` 可當檔案輸入 smoke。它**不代表**麥克風驗收。

## 4. 限制
- 只驗證過本機（macOS 26.6.2 arm64）的介面與麥克風錄音。模型往返與 Live 待 DGX 窗口實測後更新。
- MiMo-Audio-7B-Instruct：turn-based（非全雙工），max_tokens 200；端點需 DGX 管理者提供（範例未內建）。
- 左側 Audio models 若設定 DGX 控制器（需 SSH 權限），可能列出較多舊模型；精簡版待 library 0.1.6。
