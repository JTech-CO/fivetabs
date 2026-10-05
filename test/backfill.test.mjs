// 과거 항목 백필 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, savePicks, getPicksByDate, getBackfillTargets, updateItemContent, resetIncompleteBackfills } from '../src/db/index.mjs';
import { runBackfill } from '../src/pipeline/backfill.mjs';
import { withKey } from './helpers.mjs';

const item = (over = {}) => ({
  source: 'hackernews', sourceItemId: 'h1', title: 'English Title', titleKo: 'English Title',
  summary: 'english summary', summaryKo: null, url: 'https://example.com/a',
  popularitySignal: 10, publishedAt: '2026-08-01T00:00:00Z',
  selectionReason: 'primary', isTranslated: false, ...over,
});

function seed(path = ':memory:') {
  const db = openDb(path);
  savePicks(db, {
    pickDate: '2026-08-01',
    items: [item(), item({ source: 'arxiv', sourceItemId: 'a1', title: 'Paper' })],
  });
  savePicks(db, { pickDate: '2026-08-02', items: [item({ sourceItemId: 'h2', title: 'Another' })] });
  return db;
}

test('getBackfillTargets: 번역 안 된 항목을 최신순으로 반환', () => {
  const db = seed();
  const targets = getBackfillTargets(db, { limit: 10 });
  assert.equal(targets.length, 3);
  assert.equal(targets[0].pick_date, '2026-08-02'); // 최신 먼저
  // 파이프라인 복원에 필요한 필드가 전부 있어야 한다
  for (const t of targets) {
    assert.ok(t.id && t.source && t.source_item_id && t.title_original && t.url);
  }
  db.close();
});

test('getBackfillTargets: date·source·limit 필터', () => {
  const db = seed();
  assert.equal(getBackfillTargets(db, { date: '2026-08-01', limit: 10 }).length, 2);
  assert.equal(getBackfillTargets(db, { source: 'arxiv', limit: 10 }).length, 1);
  assert.equal(getBackfillTargets(db, { limit: 2 }).length, 2);
  db.close();
});

test('updateItemContent: 해당 행만 갱신하고 그날 다른 행은 건드리지 않는다', () => {
  const db = seed();
  const [target] = getBackfillTargets(db, { date: '2026-08-01', source: 'arxiv', limit: 1 });
  updateItemContent(db, target.id, {
    titleKo: '논문 제목', summaryKo: '한국어 요약', isTranslated: true,
    detailTranslation: '전문 번역', detailSummary: '핵심 요약', detailBlog: '# 블로그',
  });

  const rows = getPicksByDate(db, '2026-08-01');
  assert.equal(rows.length, 2);                                  // 행이 사라지지 않음
  const arxiv = rows.find(r => r.source === 'arxiv');
  assert.equal(arxiv.title_ko, '논문 제목');
  assert.equal(arxiv.is_translated, 1);
  assert.equal(arxiv.detail_blog, '# 블로그');
  assert.equal(arxiv.rank, target.id ? arxiv.rank : arxiv.rank); // rank 보존
  const hn = rows.find(r => r.source === 'hackernews');
  assert.equal(hn.title_ko, 'English Title');                    // 다른 행 미변경
  db.close();
});

test('백필한 행은 다시 대상이 되지 않는다(재과금 방지)', () => {
  const db = seed();
  const [t] = getBackfillTargets(db, { limit: 1 });
  updateItemContent(db, t.id, { titleKo: '번역됨', isTranslated: true, detailSummary: '요약' });
  const remaining = getBackfillTargets(db, { limit: 10 });
  assert.equal(remaining.length, 2);
  assert.ok(!remaining.some(r => r.id === t.id));
  db.close();
});

test('결과가 비어도 backfilled_at이 찍혀 재시도하지 않는다', () => {
  const db = seed();
  const [t] = getBackfillTargets(db, { limit: 1 });
  // 전문·요약이 없어 아무것도 생성하지 못한 경우
  updateItemContent(db, t.id, { titleKo: null, isTranslated: false, detailSummary: null });
  assert.ok(!getBackfillTargets(db, { limit: 10 }).some(r => r.id === t.id));
  db.close();
});

// ── 빈 결과로 끝난 백필 되돌리기 ──────────────────────

function seeded() {
  const db = openDb(':memory:');
  savePicks(db, { pickDate: '2026-08-01', items: [
    item({ sourceItemId: 'ok' }),
    item({ sourceItemId: 'empty' }),
  ] });
  const rows = getBackfillTargets(db, { limit: 10 });
  const byKey = Object.fromEntries(rows.map(r => [r.source_item_id, r.id]));
  // 한 행은 생성 성공, 한 행은 LLM이 실패해 전부 null. 둘 다 backfilled_at은 찍힌다
  updateItemContent(db, byKey.ok, {
    titleKo: '번역됨', isTranslated: true, detailTranslation: '번역본', detailSummary: '요약', detailBlog: '초안',
  });
  updateItemContent(db, byKey.empty, { isTranslated: false });
  return db;
}

test('백필: 실패해도 backfilled_at이 찍혀 다음 실행에서 건너뛰다', () => {
  const db = seeded();
  assert.equal(getBackfillTargets(db, { limit: 10 }).length, 0);
});

test('백필: resetIncompleteBackfills는 다 채워진 행은 건드리지 않는다', () => {
  // 회귀: 응답 잘림·rate limit 같은 일시 실패가 영구 포기가 되던 문제
  const db = seeded();
  assert.equal(resetIncompleteBackfills(db), 1);
  const again = getBackfillTargets(db, { limit: 10 });
  assert.equal(again.length, 1);
  assert.equal(again[0].source_item_id, 'empty');   // 성공한 행은 그대로
});

test('백필: 일부만 나온 행(번역본만 비었음)도 되돌린다', () => {
  // 회귀: 전부 비어야만 되돌려서, 요약은 나왔지만 번역본이 잘린 15건이 영영 남았다
  const db = seeded();
  const okId = db.prepare("SELECT id FROM daily_picks WHERE source_item_id = 'ok'").get().id;
  db.prepare('UPDATE daily_picks SET detail_translation = NULL WHERE id = ?').run(okId);
  assert.equal(resetIncompleteBackfills(db), 2);
  // 재실행에서 번역본만 새로 나와도 기존 요약·초안은 보존된다(COALESCE)
  updateItemContent(db, okId, { isTranslated: true, detailTranslation: '새 번역본' });
  const row = db.prepare('SELECT detail_translation t, detail_summary s, detail_blog b FROM daily_picks WHERE id = ?').get(okId);
  assert.deepEqual({ ...row }, { t: '새 번역본', s: '요약', b: '초안' });
});

test('백필: 다 채워진 GeekNews 행은 is_translated=0이어도 대상이 아니다', () => {
  // GeekNews는 정제만 하므로 is_translated가 늘 0. 그것만 보고 매번 다시 과금하던 문제
  const db = openDb(':memory:');
  savePicks(db, { pickDate: '2026-08-01', items: [item({
    source: 'geeknews', sourceItemId: 'g1', isTranslated: false,
    detailTranslation: '정제본', detailSummary: '요약', detailBlog: '초안',
  })] });
  assert.equal(getBackfillTargets(db, { limit: 10 }).length, 0);
});

test('백필: 되돌릴 것이 없으면 0을 반환(멱등)', () => {
  const db = seeded();
  resetIncompleteBackfills(db);
  updateItemContent(db, getBackfillTargets(db, { limit: 10 })[0].id, {
    isTranslated: true, detailTranslation: '번역본', detailSummary: '이번엔 성공', detailBlog: '초안',
  });
  assert.equal(resetIncompleteBackfills(db), 0);
});

test('백필: 크레딧이 바닥나면 멈추고 남은 행을 빈 결과로 찍지 않는다', withKey(async () => {
  // 회귀: 크레딧 소진 뒤에도 끝까지 돌며 남은 293건을 "빈 결과"로 소모했다
  const dir = mkdtempSync(join(tmpdir(), 'fivetabs-backfill-'));
  const dbPath = join(dir, 'test.db');
  const realFetch = globalThis.fetch;
  try {
    seed(dbPath).close();
    globalThis.fetch = async () => ({
      ok: false, status: 400, statusText: 'Bad Request',
      async text() { return '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'; },
    });
    const result = await runBackfill({ limit: 10, dbPath });
    assert.equal(result.aborted, true);

    const db = openDb(dbPath);
    assert.equal(getBackfillTargets(db, { limit: 10 }).length, 3);   // 하나도 소모되지 않음
    db.close();
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
}));

test('백필: 일시 오류(429)는 멈추지 않고 다음 행으로 넘어간다', withKey(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fivetabs-backfill-'));
  const dbPath = join(dir, 'test.db');
  const realFetch = globalThis.fetch;
  try {
    seed(dbPath).close();
    globalThis.fetch = async () => ({
      ok: false, status: 429, statusText: 'Too Many Requests', async text() { return 'rate limited'; },
    });
    const result = await runBackfill({ limit: 10, dbPath });
    assert.equal(result.aborted, undefined);
    assert.equal(result.skipped, 3);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
}));

test('백필: 이미 있는 번역·상세는 다시 만들거나 덮어쓰지 않고 빈 칸만 채운다', withKey(async () => {
  // 모델을 Sonnet 5 -> 5.5로 바꿔도(10/6) 앞서 만든 글은 그대로 둔다
  const dir = mkdtempSync(join(tmpdir(), 'fivetabs-backfill-'));
  const dbPath = join(dir, 'test.db');
  const realFetch = globalThis.fetch;
  let llmCalls = 0;
  try {
    const db = openDb(dbPath);
    savePicks(db, { pickDate: '2026-08-01', items: [item({
      source: 'arxiv', sourceItemId: 'a1', titleKo: '기존 제목', isTranslated: true,
      detailTranslation: null, detailSummary: '기존 요약', detailBlog: '기존 초안',
    })] });
    db.close();
    globalThis.fetch = async () => {
      llmCalls++;
      const out = { title_ko: '새 제목', summary_ko: '새', translation: '새 번역본', summary: '새 요약', blog: '새 초안' };
      return { ok: true, status: 200, async json() { return { content: [{ type: 'text', text: JSON.stringify(out) }] }; } };
    };
    await runBackfill({ limit: 10, dbPath });

    const check = openDb(dbPath);
    const row = check.prepare('SELECT title_ko t, detail_translation dt, detail_summary ds, detail_blog db FROM daily_picks').get();
    check.close();
    assert.equal(llmCalls, 1);   // 번역은 건너뛰고 상세 1콜만
    assert.deepEqual({ ...row }, { t: '기존 제목', dt: '새 번역본', ds: '기존 요약', db: '기존 초안' });
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
}));
