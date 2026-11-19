# わが家の今日（家族アプリ）— 作業メモ

Kenと妻の2人だけが使う、iPhoneのホーム画面アプリ（PWA）。説明はいつも日本語で、結論から。

## 構成
- 画面：このリポジトリ → GitHub Pages `https://ditakenmaru.github.io/wagaya/`（mainに置くと1〜2分で反映）
  - `index.html`：CSSと画面のテンプレート（`<template id="tpl">`。`{{式}}`、`<sc-for list as>`、`<sc-if value>`、`onClick="{{関数}}"`）
  - `app.js`：自前の小さな描画の仕組み（差分更新）＋画面のロジック（`App.renderVals()`）＋通信。`?demo=1` で通信なしの見本モード
  - `config.js`：GASのURLとOAuthクライアントID（秘密ではない）
  - `sw.js`：画面のファイルだけキャッシュ（ネット優先）。写真は Cache Storage `wagaya-photos` に端末保存
- Google側：`gas/Code.gs` と `gas/appsscript.json` を、スプレッドシート「WAGAYA DB」（maru_app_create のアカウント）の Apps Script に貼って使う
  - ウェブアプリ（実行：自分、アクセス：全員）。中身はログインした2人だけに返す
  - シート：設定／担当／チェック／申し送り／日記／献立／買い物／予定／中期／ニュース／_sessions
  - 「設定」シート B列：クライアントID、パパのメール、ママのメール、カレンダーID（空なら「予定」シート）、写真フォルダID（Googleドライブ）
- ログイン：Googleの id_token をリダイレクトで受け取り（ポップアップなし）、GASが tokeninfo で確かめ、設定の2人なら180日のセッションを発行（_sessionsにはハッシュだけ保存）

## GASのコードを変えた時（Kenの手作業が要る）
1. Apps Script の `コード.gs`（と必要なら appsscript.json）を `https://raw.githubusercontent.com/ditakenmaru/wagaya/main/gas/…` の中身に貼り替えて保存
2. 権限が増えた時は関数 setup を実行して許可（setupは何度実行しても既存の行を上書きしない）
3. デプロイ → デプロイを管理 → 鉛筆 → バージョン「新バージョン」→ デプロイ（URLは変わらない）

## 確かめ方
- 画面：`python3 -m http.server` で配信し、Playwright で `index.html?demo=1` をiPhoneサイズで撮る
- GAS：Node で SpreadsheetApp などをまねて doPost を呼ぶテスト（ログイン、書き込み、読み出し、ログアウト）
- 実物：GAS と github.io は作業環境の網から届かない。Kenのパソコンの内蔵ブラウザ（Claude_Browser）で github.io を開き、fetch で確かめる

## 守ること
- このリポジトリは公開。家族のデータ、写真、メールアドレス、秘密の値（クライアントシークレットなど）を置かない
- 子どもの写真はMuseに渡さない。妻のiCloudに直接つながない
- 妻と合意していないことを決定扱いしない
