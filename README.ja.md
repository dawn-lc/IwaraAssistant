# IwaraAssistant

[中文](README.md) ｜ [English](README.en.md)

[![CI](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml/badge.svg)](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Firefox AMO](https://img.shields.io/amo/v/iwara-assistant?label=AMO&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/firefox/addon/iwara-assistant/)
[![AMO ユーザー](https://img.shields.io/amo/users/iwara-assistant?label=users)](https://addons.mozilla.org/firefox/addon/iwara-assistant/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.11-5FA04E?logo=nodedotjs&logoColor=white)](package.json)

**Iwara Assistant** は [iwara.tv](https://www.iwara.tv) 用の**ブラウザ拡張**で、サイトでのダウンロードと管理の体験を向上させることを目的としています。選択・投入・キュー・進捗・移行は拡張自身のページに集約し、サイト側には「チェック / ダウンロード」といった高頻度の操作だけを残します。

- **Chrome（MV3）と Firefox（MV2）が同じコードを共有**しており、挙動は一致します。
- 4 つのダウンロード経路：ブラウザ内蔵ダウンロード、aria2、iwaradl、直リンクを外部ダウンローダーに渡す。
- 結果のフィードバックはシステム通知のみで、クリックすれば該当する場所へ移動できます。
- いかなるデータも収集せず、開発者へ送信しません。

> [!IMPORTANT]
> **Firefox は [AMO](https://addons.mozilla.org/firefox/addon/iwara-assistant/) で公開済み**です（自動更新）。**Chrome ウェブストアでは拒否されました**（コンテンツ ポリシーによる判定で禁止事項にあたり、コードの変更では解決できません）。Chromium 系は手動で読み込んでください。機能はストアからインストールした場合とまったく同じです。理由は[後述](#なぜストアにないのか)を参照してください。

> **使い方は [Wiki](https://github.com/dawn-lc/IwaraAssistant/wiki)、実装は [docs/](docs/) を参照してください。** この文書では位置づけとインストールだけを扱います。

## 機能

| 分野         | 機能                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ダウンロード | 4 つの経路、パステンプレートとリアルタイムプレビュー、リンクの事前チェック、一括の重複排除、ブラウザ経路の同時実行上限、失敗時の再試行、メタデータ JSON                                          |
| ページ       | カードのチェックボックスとタブをまたぐ選択範囲、全選択 / 反転 / 解除、フローティングメニュー、動画 ID の手動入力、美化スタイルとワイド表示、右下の透かし、SPA のページ切り替え時の自動再スキャン |
| タスク       | キューのグループ分け（対応が必要 / 進行中 / 完了）、進捗、再試行、削除（先にダウンローダー側を中止）、終了済みの消去、起動時の突き合わせ、ツールバーのバッジ                                     |
| 設定         | 9 つのタブ、即時保存、表示言語 `auto` / 中文 / English / 日本語、設定の検証と既定値                                                                                                              |
| 移行         | 旧ユーザースクリプトのページ内データベースを読み取り専用で自動検出し、明示的なワンクリックでインポート。設定は生の JSON の貼り付け、または完全な移行パッケージのインポートに対応                 |
| 通知         | バックグラウンドで起きたイベント（キュー登録、完了、失敗、ファイル共有リンクの検出）のみシステム通知で知らせ、クリックで該当の場所へ移動                                                         |
| セキュリティ | フィッシング・偽サイト対策：全画面の警告 + ネットワーク層での遮断。ユーザーが明確に「アクセスを続ける」を選んだ後にのみ許可                                                                      |
| ソーシャル   | 自動フォロー / 自動いいね、フレンド申請の一括承認（9 種類の条件、any / all モード、リアルタイム進捗）                                                                                            |
| 同期         | 全投稿をページ単位で巡回してライブラリに取り込み（一時停止 / 再開 / 中断した位置からの再開が可能）、登録フィードの同期、MediaCenter へのプッシュと逆方向の補完                                   |

## インストール

| ブラウザ                                      | インストール方法                                                                             | 備考                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Firefox 128+**                              | [AMO ストアからインストール](https://addons.mozilla.org/firefox/addon/iwara-assistant/)      | 審査済み、自動更新                       |
| Chrome / Edge / Brave / Vivaldi / Opera / Arc | 手動で読み込む（[手順](https://github.com/dawn-lc/IwaraAssistant/wiki/Chromium-系手动安装)） | ストアでは拒否済み。機能はストア版と同一 |

### Firefox（推奨）

[AMO 製品ページ](https://addons.mozilla.org/firefox/addon/iwara-assistant/) で「Firefox に追加」を押せばインストールは完了です。公開版のバージョン番号は製品ページの表示に従います（バッジも同じ出所です）。リリースのたびに審査を受けるため、ストアの版はリポジトリ最新のコミットより通常 1〜2 日遅れます。

公開パッケージは **MV2** なので、LAN 上の aria2 は `http://192.168.x.x:6800/jsonrpc` のままで問題ありません（MV3 のローカルネットワーク制限を受けません）。すぐに main のコードを使いたい場合は、ローカルでビルドして一時的に読み込みます：`npm install && npm run build` → `about:debugging#/runtime/this-firefox` →「一時的なアドオンを読み込む」→ `dist/firefox/manifest.json` を選択（Firefox の終了時に無効になります）。

### Chromium 系（Chrome / Edge / Brave / Vivaldi / Opera）

**方法 1：ソースからビルド**（Node 20.11 以上が必要）—— 本リポジトリを `git clone` したうえで `npm install && npm run build:chrome`。成果物は `dist/chrome` にあります。
**方法 2：CI の成果物をダウンロード** —— [Actions](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml) で最新の成功した実行を選び → Artifacts → `extension-zips` → 展開して `chrome.zip` を取り出します。

ディレクトリを用意したら、`chrome://extensions`（Edge は `edge://extensions`）を開き →「デベロッパー モード」を有効化 →「パッケージ化されていない拡張機能を読み込む」→ **`manifest.json` を直接含む**ディレクトリを選び → 開いている iwara のページを再読み込みします。更新・ロールバック・データの保持・トラブルシューティングを含む完全な手順は [Wiki：Chromium 系の手動インストール](https://github.com/dawn-lc/IwaraAssistant/wiki/Chromium-系手动安装) を参照してください。

> 成果物は本リポジトリのソース、または本リポジトリの Actions からのみ取得してください。第三者が転載した zip / crx はソースと照合できないため、使わないでください。

### なぜストアにないのか

2026-10-30 に提出したバージョンは **Chrome ウェブストアで拒否**されました。違反種別は「コンテンツ ポリシー」、参照 ID は `Grey Lithium`（性的コンテンツ）で、根拠は「当社は、ユーザーをそのようなコンテンツに誘導する製品を公開することはできません」、是正要求は「修正して再提出」ではなく「公開停止」でした。

拡張自体は成人向けコンテンツを含まず、表示もしません。コードに露骨な素材はなく、アイコンは自前で描いた SVG、JS はすべてパッケージ内にバンドルされ、サイトの制限をプロキシしたり回避したりしません。拒否の実際の理由は**対象としているサイト**にあります。すなわち、iwara.tv にのみ作用し、そのサイトが成人向けサイトだからです。これは Chrome の禁止事項であり是正できる項目ではないため、再提出は行いません。審査を通すために拡張を「汎用ダウンローダー」に変えたりサイト名を消したりはしません。それは欺瞞行為とキーワードの詰め込みの条項に同時に触れることになり、サイトの性質が変わるわけでもありません。同じコードは AMO では承認されています。詳細な記録は [docs/store-listing.md](docs/store-listing.md) を参照してください。

## ドキュメント

| 参照先                                                     | 内容                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Wiki**](https://github.com/dawn-lc/IwaraAssistant/wiki) | 利用者向け：インストール（Chromium 系の手動インストールを含む）、ダウンロード経路とエンドポイント、パスで使える変数、一括の投入、タスクキューと自動復旧、非公開・限定公開の動画、旧ライブラリの移行、同期と MediaCenter、デバッグとデータのエクスポート、トラブルシューティング、よくある質問 |
| [docs/05-features.md](docs/05-features.md)                 | 機能と挙動の境界についての正式な一覧（「意図的にやらない」判断を含む）                                                                                                                                                                                                                        |
| [docs/](docs/)                                             | 技術的な実装：アーキテクチャ、ブラウザ間の差異、manifest、メッセージプロトコル、テストとリリース、aria2 の流れ、デバッグチャネル、AMO の掲載素材                                                                                                                                              |

## 開発

```bash
npm install          # Node 20.11 以上
npm run build        # 2 ターゲットのビルド + パッケージング → dist/chrome、dist/firefox とそれぞれの .zip
npm run dev:chrome   # watch モード
npm run test:unit    # ユニットテスト。ほかに test:e2e（Playwright）と test:e2e:wdio（Chrome + Firefox）
```

**コントリビュートする場合**はまず [CONTRIBUTING.md](CONTRIBUTING.md) を読んでください（環境、ゲート、コミット規約、PR の流れ）。**コードに手を入れる前に [AGENTS.md](AGENTS.md) を必ず読んでください**——ゲートの一覧、アーキテクチャの鉄則、ディレクトリの帰属、そして一連の「プラットフォームの事実」が書かれており、その背景にある実測の記録は [docs/agent-notes.md](docs/agent-notes.md) にあります。セキュリティ上の脆弱性は [SECURITY.md](SECURITY.md) の非公開チャネルから報告し、公開 issue を立てないでください。

## 依存関係とライセンス

本プロジェクトは [Apache-2.0](LICENSE) でオープンソース化されています。サードパーティの依存関係（ランタイムコードはすべて拡張にバンドルされ、リモートコードは一切読み込みません）：

| 依存関係                                                      | 用途                                     | ライセンス |
| ------------------------------------------------------------- | ---------------------------------------- | ---------- |
| [zod](https://github.com/colinhacks/zod)                      | 設定スキーマと不正データのフォールバック | MIT        |
| [idb](https://github.com/jakearchibald/idb)                   | IndexedDB の Promise ラッパー            | ISC        |
| [React](https://github.com/facebook/react) / react-dom        | 拡張ページの UI                          | MIT        |
| [i18next](https://github.com/i18next/i18next) / react-i18next | 3 言語の UI と文案の検証                 | MIT        |
| [sonner](https://github.com/emilkowalski/sonner)              | ページ内の軽い通知                       | MIT        |
| [dayjs](https://github.com/iamkun/dayjs)                      | パステンプレートの時刻書式               | MIT        |

開発・ビルドのツールチェーン：TypeScript（Apache-2.0）、esbuild（MIT）、tsx（MIT）、Prettier（MIT）、Playwright（Apache-2.0）、WebdriverIO（MIT）、web-ext（MPL-2.0）、resvg（MPL-2.0）。アイコンはリポジトリ内で自前で描いた SVG をビルド時にレンダリングしたもので、サードパーティの素材は使っていません。

## 類似プロジェクトと謝辞

- [IwaraDownloadTool](https://github.com/IwaraEnhance/IwaraDownloadTool)（Apache-2.0）：本プロジェクトの機能面と一連の境界挙動は、このユーザースクリプトを参考にしています。移行タブは、その旧ユーザーのために用意したものです。
- [iwaradl](https://github.com/Izumiko/iwaradl)（MIT）：CLI ダウンローダー。本プロジェクトではダウンロードバックエンドの 1 つとして使っています。
- [MediaCenter](https://github.com/dawn-lc/MediaCenter)：ローカルメディアライブラリ。実験的なメタデータのプッシュ先です。
- [aria2](https://github.com/aria2/aria2) と [Motrix-Next](https://github.com/AnInsomniacy/motrix-next)：推奨するセルフホスト型のダウンローダーと GUI。

issue を投稿してくださった方、実測ログを提供してくださった方、修正の検証に協力してくださった方に感謝します。「プラットフォームの事実」の多くは、こうしたフィードバックから修正されてきたものです。

## Iwara との関係と免責事項

- 本プロジェクトは独立して開発されたサードパーティ製ツールであり、Iwara 公式と**提携・許諾・所属の関係は一切ありません**。
- サイトが公開しているページと API を通してのみやり取りします。アクセス制御を回避せず、有料コンテンツや非公開コンテンツを解読せず、動画のプロキシや転送も行いません。
- ダウンロード行為がお住まいの地域の法令および Iwara の利用規約に適合するかはご自身で確認してください。開発者および貢献者は、アカウント制限を含むがこれに限らない利用の結果について責任を負いません。
- サイトのコンテンツを気に入った場合は、クリエイターを優先的に支援してください：[Iwara プレミアム](https://www.iwara.tv/page/premium)に加入するか、作者に直接投げ銭してください。
- 本プロジェクトは [Apache-2.0](LICENSE) でオープンソース化されており、コードとドキュメントは「現状のまま」提供され、明示・黙示を問わずいかなる保証も伴いません。

## プライバシーとライセンス

拡張はいかなるデータも収集せず、開発者へ送信しません。権限の 2 つの用途は [Wiki の権限についての説明](https://github.com/dawn-lc/IwaraAssistant/wiki/安装与首次配置#权限说明为什么需要全站访问) を参照してください。プライバシーポリシーは [PRIVACY.md](PRIVACY.md)、ライセンスは [Apache-2.0](LICENSE) です。
