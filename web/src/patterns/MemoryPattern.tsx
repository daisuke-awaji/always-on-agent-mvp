import { FileText, NotebookText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge-clean';
import { Button } from '@/components/ui/button-clean';
import { AlertDialog } from '@/components/ui/dialog-clean';
import { TextArea } from '@/components/ui/text-area-clean';
import { ApiError, deleteMemoryFile, writeMemoryFile } from '../api/client';
import { MEMORY_LIMITS, type MemoryFile, type MemoryFileMeta } from '../api/schema';
import { Empty, ListSkeleton, PaneHeader } from '../ui/components';
import { relativeTime } from '../ui/derive';
import { baseName, byteLength, groupMemory, isAutoload, sizeLabel } from '../ui/memory';
import type { Navigation } from '../ui/route';
import { useNow } from '../ui/useAgentData';
import { useMemoryFile, useMemoryList } from '../ui/useResource';

/**
 * メモリ。エージェントの memory/<userId>/ にあるファイルを、記事の種類ごとに並べる:
 *   あなたからの指示（instructions.md）、あなたについてのメモ（notes/）、続いているタスク（tasks/）。
 * 開いて読む、書き換える、古いメモを消す、ができる。開いているファイルは URL で持つ（#/memory/notes/family.md）。
 *
 * エージェントは run のたびにメモリを書き換える。編集を始めたあとにエージェントが書き換えたら、
 * 保存は 409 になる（上書きしない）。そのときは最新を読み込んでから直す。
 */
export function MemoryPattern({
  userId,
  sub,
  nav,
  onToast,
}: {
  userId: string;
  sub?: string;
  nav: Navigation;
  onToast: (msg: string) => void;
}) {
  const now = useNow();
  const list = useMemoryList(userId);
  const files = list.data?.files ?? [];
  const groups = groupMemory(files);

  const open = (path: string) => {
    nav.open({ view: 'memory', sub: path });
  };

  return (
    <div className="chat split">
      <aside className="chat-list split-list" aria-label="メモリのファイル">
        <div className="chat-list-head">
          <h2 className="chat-list-title-head">メモリ</h2>
          {list.data && (
            <span className="list-usage">
              {files.length} / {list.data.limits.maxFiles} ファイル
            </span>
          )}
        </div>
        {!list.loaded && <ListSkeleton label="メモリを読み込み中" />}
        {list.loaded &&
          groups.map((g) => (
            <section key={g.id} className="list-section" aria-label={g.label}>
              <h3 className="list-section-title">{g.label}</h3>
              <p className="list-section-desc">{g.description}</p>
              {g.files.length === 0 ? (
                <p className="list-section-empty">まだありません</p>
              ) : (
                <ul>
                  {g.files.map((f) => (
                    <li key={f.path}>
                      <FileRow f={f} active={sub === f.path} now={now} onOpen={open} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        {list.loaded && (
          <section className="list-section" aria-label="送ったメッセージ">
            <h3 className="list-section-title">送ったメッセージ</h3>
            <p className="list-section-desc">
              ファイルにはしない。同じことを何度も言わないよう、worker が直近の 5 件を毎回エージェントに渡す。
            </p>
          </section>
        )}
      </aside>

      <section className="chat-thread split-detail" aria-label="ファイル">
        {sub ? (
          <FileView
            key={sub}
            userId={userId}
            path={sub}
            now={now}
            nav={nav}
            onSaved={(msg) => {
              list.refresh();
              onToast(msg);
            }}
            onDeleted={(msg) => {
              list.refresh();
              onToast(msg);
              nav.replace({ view: 'memory' });
            }}
          />
        ) : (
          <>
            <PaneHeader title="メモリのしくみ" />
            <div className="pane-scroll">
              <MemoryIntro onOpen={open} hasInstructions={files.some((f) => f.path === 'instructions.md')} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function FileRow({
  f,
  active,
  now,
  onOpen,
}: {
  f: MemoryFileMeta;
  active: boolean;
  now: number;
  onOpen: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className={`chat-list-item ${active ? 'active' : ''}`}
      onClick={() => {
        onOpen(f.path);
      }}
    >
      <span className="chat-list-title">
        <span className="ellipsis mono-name">{baseName(f.path)}</span>
        <span className="chat-list-time">{relativeTime(f.updatedAt, now)}</span>
      </span>
      <span className="chat-list-preview">
        <span className="ellipsis">
          {sizeLabel(f.size)} · {f.updatedBy === 'user' ? 'あなたが更新' : 'エージェントが更新'}
        </span>
        {isAutoload(f.path) && <Badge tone="neutral">毎回読み込む</Badge>}
      </span>
    </button>
  );
}

function MemoryIntro({ onOpen, hasInstructions }: { onOpen: (path: string) => void; hasInstructions: boolean }) {
  return (
    <div className="pane-body intro">
      <p>
        エージェントは run のたびに起きて、終わると眠ります。前の run
        のことは覚えていないので、続けて知っておくべきことはメモリのファイルに書いておきます。
      </p>
      <div className="intro-cards">
        <div className="intro-card">
          <FileText size={18} strokeWidth={1.9} aria-hidden />
          <h3>毎回読み込む</h3>
          <p>instructions.md と、notes/ と tasks/ の index.md。run の最初に必ず読むので、短く保ちます。</p>
        </div>
        <div className="intro-card">
          <NotebookText size={18} strokeWidth={1.9} aria-hidden />
          <h3>必要なときに開く</h3>
          <p>そのほかのメモとタスクのファイル。エージェントは index を見て、要るものだけを開きます。</p>
        </div>
      </div>
      <p className="muted">
        書き換えると、次の run からその内容で動きます。古くなったメモは消してください（index.md の行も一緒に消えます）。
      </p>
      {hasInstructions && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onOpen('instructions.md');
            }}
          >
            あなたからの指示を開く
          </Button>
        </div>
      )}
    </div>
  );
}

function FileView({
  userId,
  path,
  now,
  nav,
  onSaved,
  onDeleted,
}: {
  userId: string;
  path: string;
  now: number;
  nav: Navigation;
  onSaved: (msg: string) => void;
  onDeleted: (msg: string) => void;
}) {
  const res = useMemoryFile(userId, path);
  const file = res.data;
  // 編集中: 編集を始めたときの版と、書いている途中の中身
  const [draft, setDraft] = useState<{ base: MemoryFile; text: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  // 編集を始めたとき・最新を読み込み直したときは、入力欄の最後にカーソルを置く
  const [focusSeq, setFocusSeq] = useState(0);
  useEffect(() => {
    const el = editor.current;
    if (focusSeq === 0 || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusSeq]);
  const autoload = isAutoload(path);
  // 編集を始めたあとに、エージェント（run）がこのファイルを書き換えた
  const changedUnderneath = draft && file && file.version !== draft.base.version;

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await writeMemoryFile(userId, path, draft.text, draft.base.version);
      setDraft(undefined);
      setConflict(false);
      res.refresh();
      onSaved(`${path} を保存しました。次の run からこの内容で動きます`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      else setError(err instanceof ApiError ? `保存できませんでした: ${err.message}` : '保存できませんでした');
    } finally {
      setBusy(false);
    }
  };

  const reload = () => {
    if (!file) return;
    setDraft({ base: file, text: file.content });
    setConflict(false);
    setFocusSeq((n) => n + 1);
  };

  const sub = file
    ? `${autoload ? '毎回読み込む · ' : ''}${sizeLabel(file.size)} · ${file.updatedBy === 'user' ? 'あなた' : 'エージェント'}が更新（${relativeTime(file.updatedAt, now)}）`
    : undefined;
  const bytes = draft ? byteLength(draft.text) : 0;
  const tooLarge = bytes > MEMORY_LIMITS.maxFileBytes;

  return (
    <>
      <PaneHeader
        title={<span className="mono-name">{path}</span>}
        sub={sub}
        onBack={nav.backToList}
        backLabel="メモリの一覧に戻る"
      >
        {file && !draft && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setDraft({ base: file, text: file.content });
                setError(undefined);
                setFocusSeq((n) => n + 1);
              }}
            >
              編集
            </Button>
            {!autoload && (
              <AlertDialog
                title={`${baseName(path)} を消しますか？`}
                description={`エージェントは次の run から、このファイルを使いません。${path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/index.md の、このファイルを指す行も消します。` : ''}消したファイルは、この画面からは戻せません。`}
                confirmLabel="消す"
                cancelLabel="やめる"
                danger
                onConfirm={async () => {
                  setError(undefined);
                  try {
                    await deleteMemoryFile(userId, path, file.version);
                    onDeleted(`${path} を消しました`);
                  } catch (err) {
                    if (err instanceof ApiError && err.status === 409) {
                      setError(
                        '消す前に、エージェントがこのファイルを書き換えました。中身を確かめてから、もう一度消してください。',
                      );
                      res.refresh();
                    } else {
                      setError(err instanceof ApiError ? `消せませんでした: ${err.message}` : '消せませんでした');
                    }
                  }
                }}
                trigger={
                  <Button variant="destructive" size="sm">
                    削除
                  </Button>
                }
              />
            )}
          </>
        )}
      </PaneHeader>
      <div className="pane-scroll">
        <div className="pane-body">
          {!res.loaded && <ListSkeleton label="ファイルを読み込み中" />}
          {res.notFound && <Empty title="このファイルはありません">消されたか、名前が変わった可能性があります。</Empty>}
          {res.error && !file && <p className="form-error">読み込めませんでした: {res.error}</p>}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {file && !draft && <pre className="memory-text">{file.content}</pre>}
          {draft && (
            <div className="form">
              {(conflict || changedUnderneath) && (
                <div className="notice" role="alert">
                  <p>
                    {conflict ? '保存できませんでした（409）。' : ''}
                    編集を始めたあとに、エージェントがこのファイルを書き換えました。上書きしないよう、保存は止めています。
                  </p>
                  <Button variant="secondary" size="sm" onClick={reload}>
                    最新を読み込む（今の編集は消えます）
                  </Button>
                </div>
              )}
              <TextArea
                ref={editor}
                label="内容"
                aria-describedby="memory-size"
                value={draft.text}
                minRows={10}
                maxRows={24}
                inputClassName="memory-editor"
                error={tooLarge ? `${sizeLabel(MEMORY_LIMITS.maxFileBytes)} までです` : undefined}
                onChange={(e) => {
                  setDraft({ ...draft, text: e.target.value });
                }}
                onSubmitShortcut={() => void save()}
              />
              <p className={`form-preview ${tooLarge ? 'problem' : ''}`} id="memory-size">
                {autoload
                  ? '毎回の run の最初に読み込みます。短く保ってください。'
                  : 'エージェントが必要なときに開きます。'}{' '}
                {sizeLabel(bytes)} / {sizeLabel(MEMORY_LIMITS.maxFileBytes)}
              </p>
              <div className="form-actions">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDraft(undefined);
                    setConflict(false);
                  }}
                >
                  やめる
                </Button>
                <Button
                  loading={busy}
                  disabled={tooLarge || Boolean(changedUnderneath) || draft.text === draft.base.content}
                  onClick={() => void save()}
                >
                  保存
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
