# 選屋系統（漢皇集團 · 都更權變選配）

兩個網站、一個資料庫：

| 網站 | 網址 | 給誰用 |
|---|---|---|
| 前台 `index.html` | `https://<組織>.github.io/<專案>/` | 地主、住戶：看即時選屋狀態、平面圖、查自己的選配結果 |
| 後台 `admin.html` | `https://<組織>.github.io/<專案>/admin.html` | 選屋人員：登錄選屋、合併選配、抽籤結果、文件歸檔、匯出 |

資料存在 **Supabase**（免費方案）。掃描文件存在公司的 **Google Drive**。

---

## 開新個案（第一次架設也照這個做）

約 30 分鐘。每一步做完打勾。

### 1. GitHub：建立網站

1. 用這個專案當模板：在模板專案首頁按 **Use this template → Create a new repository**
   （第一次架設模板本身時，把檔案上傳到新專案，並在 Settings 勾選 **Template repository**）
   - Owner：公司的組織（例如 `hanhuang`）
   - Repository name：個案的英文簡稱，例如 `qingshui`（網址會是 `https://hanhuang.github.io/qingshui/`）
   - 選 **Public**（GitHub Pages 免費方案需要公開；個資都在 Supabase，不在程式碼裡）
2. 新專案 → **Settings → Pages** → Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾 `/ (root)` → Save
3. 一兩分鐘後，頁面上方會出現網址

### 2. Supabase：建立資料庫

1. supabase.com → **New project**
   - Name：跟 GitHub 專案同名
   - Database Password：按 Generate，另外存好
   - Region：Northeast Asia (Tokyo)
2. 左邊 **SQL Editor** → New query → 把 `supabase/01_schema.sql` 整份貼上 → **Run**
3. 個案資料：登入後台後用「匯入資料」上傳 Excel 最簡單。也可以在 SQL Editor 執行個案的資料 SQL（例如清水段的 `02_seed_qingshui.sql`）。
   > ⚠️ 地主姓名、權值、身分證等個資**不要放進 GitHub**（網站專案是公開的），只存在 Supabase。
4. **Authentication → Sign In / Providers**：把 **Allow new users to sign up** 關掉（只讓管理員建立帳號）
5. **Authentication → Users → Add user → Create new user**：填管理員的 Email、密碼，勾 **Auto Confirm User**
6. 回到 **SQL Editor** 執行（換成你的 Email、姓名）：
   ```sql
   insert into staff(email, name, role) values ('yi.chang@hanhuang.com.tw', '張壹壹', 'admin');
   ```
7. **Project Settings → API**：複製 **Project URL** 和 **anon public** key

> ⚠️ `service_role` key 不要放到網站、不要傳給任何人。

### 3. 連線設定

在 GitHub 專案打開 `config.js` → 右上鉛筆（Edit）→ 填入第 2 步複製的兩個值 → **Commit changes**

```js
SUPABASE_URL: 'https://xxxx.supabase.co',
SUPABASE_ANON_KEY: 'eyJ...',
```

打開前台網址，應該會看到選屋狀態；打開 `admin.html` 用管理員帳號登入。

### 4. Google Drive：文件歸檔

1. 在公司 Drive（建議共用雲端硬碟）建立資料夾，例如「清水段選屋文件」，從網址複製資料夾 ID（`folders/` 後面那串）
2. 到 script.google.com → 新專案 → 把 `apps-script/Code.gs` 整份貼上 → 儲存
3. 左邊齒輪「專案設定」→ **指令碼屬性** 新增：
   - `ROOT_FOLDER_ID`：資料夾 ID
   - `SUPABASE_URL`、`SUPABASE_ANON_KEY`：同第 2 步
4. 右上 **部署 → 新增部署作業** → 類型「網頁應用程式」→ 執行身分「我」、存取權「任何人」→ 部署 → 授權
5. 複製網頁應用程式網址 → 後台 **案件設定 → 文件 → Google Drive 上傳網址** 貼上 → 儲存設定

### 5. 防止資料庫休眠

Supabase 免費專案一週沒人用會暫停。專案內建排程（`.github/workflows/keepalive.yml`）每天會自動連線一次，連線資訊直接讀 `config.js`，不用另外設定。

### 6. 個案資料

1. 用 `templates/選屋系統_匯入範本.xlsx` 的格式整理「地主」「房屋單元」「車位」三張表
2. 後台 **匯入資料** 上傳
3. **案件設定**：個案名稱、申請分配期間、抽籤時間地點、選配上限、最小分配單元、文件清單、前台顯示
4. 平面圖：`plans/` 資料夾（圖片與 `plans.json` 的戶別座標）需依個案選屋圖冊重新產生
5. 準備正式開放時，把「測試模式」關掉

### 7. 加入其他選屋人員

1. Supabase → Authentication → Users → Add user（Email + 密碼，勾 Auto Confirm）
2. 後台 **案件設定 → 人員與權限** 加入同一個 Email，選角色

---

## 日常操作

- **每天收工**：後台「找補彙總與匯出」→ 匯出全部資料（Excel），存一份到 Drive 當備份
- **改規則**：案件設定（管理員）
- **抽籤後**：重複與抽籤 → 點中籤者；未中者自動變「需重選」

## 檔案說明

| 檔案 | 內容 |
|---|---|
| `index.html` | 前台 |
| `admin.html`、`admin.js`、`admin.css` | 後台 |
| `config.js` | 每個個案的資料庫連線（唯一需要改的程式檔） |
| `plans/` | 平面圖與戶別位置 |
| `supabase/01_schema.sql` | 資料庫結構、權限、選配規則檢查 |
| `apps-script/Code.gs` | Google Drive 上傳程式 |
| `templates/` | Excel 匯入範本 |
