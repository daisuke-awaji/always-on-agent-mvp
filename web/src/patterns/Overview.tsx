import { PATTERNS } from '../ui/patterns';
import { buildRuns, countByStatus } from '../ui/derive';
import type { AgentData } from '../ui/useAgentData';

const DETAILS: Record<string, { good: string[]; watch: string[] }> = {
  chat: {
    good: ['チャットに慣れた人がすぐ使える', '返信がそのまま session の続きになる（sessionId を意識しなくてよい）'],
    watch: ['静かに処理した通知は見えない', 'session が増えると一覧が長くなる'],
  },
  inbox: {
    good: [
      '「エージェントから連絡が来たときだけ見る」使い方に合う',
      'なぜ知らせたか（きっかけのイベント）がわかる',
      '知らせなかったものもまとめて確認できる',
    ],
    watch: ['こちらから話しかける入口が目立たない'],
  },
  console: {
    good: [
      '受付 → 処理中 → 完了 / 失敗の流れと再試行がそのまま見える',
      'Webhook を手で送って、重複排除や検証エラーを試せる',
    ],
    watch: ['利用者向けではなく、開発・運用向け'],
  },
};

export function Overview({ data }: { data: AgentData }) {
  const c = countByStatus(data.events);
  const runs = buildRuns(data.events, data.messages);
  return (
    <div className="overview">
      <section className="overview-hero">
        <h2 className="overview-title">常駐エージェントの画面、3 つの案</h2>
        <p>
          同じ API（イベントを送る・イベントの状態を見る・送られたメッセージを見る）とデータを、3
          つの見せ方で比べるためのモックです。 バックエンドはなく、ブラウザの中の Mock Service Worker が API
          とエージェントの代わりをします。
        </p>
        <p className="muted">
          いまのデータ: イベント {data.events.length} 件（処理中 {c.processing + c.pending}・失敗 {c.failed}）、run{' '}
          {runs.length} 回、メッセージ {data.messages.length} 件。右上の「モック設定」でシナリオの切り替えと Webhook
          の送信ができます。
        </p>
      </section>
      <div className="pattern-cards">
        {PATTERNS.map((p) => {
          const d = DETAILS[p.route];
          return (
            <a key={p.route} href={`#/${p.route}`} className="pattern-card">
              <div className="pattern-card-head">
                <span className="pattern-letter">{p.letter}</span>
                <div>
                  <h2>{p.name}</h2>
                  <p className="muted">{p.tagline}</p>
                </div>
              </div>
              {d && (
                <>
                  <h3>向いていること</h3>
                  <ul>
                    {d.good.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                  <h3>気になるところ</h3>
                  <ul className="watch">
                    {d.watch.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </>
              )}
              <span className="pattern-open">開く →</span>
            </a>
          );
        })}
      </div>
      <section className="overview-notes">
        <h2>試してほしいこと</h2>
        <ol>
          <li>A でメッセージを送り、「受付済み → 処理中 → 完了」と返信が出るまでを見る</li>
          <li>「モック設定」から「関係ないリポジトリの更新」を送り、B の「知らせなかった通知」に入るのを見る</li>
          <li>「同じ Webhook をもう一度」を送り、C で duplicate: true になるのを見る</li>
          <li>シナリオを「調子が悪い」にして、失敗・再試行・読み込みエラーの見え方を比べる</li>
        </ol>
      </section>
    </div>
  );
}
