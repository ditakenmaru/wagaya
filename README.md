# わが家の今日

家族2人で使うホーム画面アプリ（PWA）。画面はこのリポジトリ（GitHub Pages）、データはGoogleのスプレッドシートとカレンダー（GAS）に置く。

- 画面：`index.html` `app.js` `config.js` `manifest.webmanifest` `sw.js` `icons/`
- Google側：`gas/Code.gs` `gas/appsscript.json`（家族DBのスプレッドシートのApps Scriptに貼る）
- ログイン：Googleアカウント。スプレッドシートの「設定」シートに書いた2人だけが使える
- 見本で動かす：`index.html?demo=1`

このリポジトリには家族のデータ・写真・メールアドレスを置かない。
