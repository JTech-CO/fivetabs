// SQLite 저장 계층 (기술 백서 §5): node:sqlite 내장 드라이버
//
// 단일 사용자·일 5~8건 규모라 단일 파일 SQLite로 충분(§5).
// UNIQUE(source, source_item_id)로 같은 항목의 재적재를 막는다.
// 같은 날 재실행(workflow_dispatch)의 멱등성은 savePicks가 그날 행을 지우고 다시 넣어 보장한다
// (ON CONFLICT는 크로스-날짜 충돌에만 걸리며, 그 경우 행이 다른 날짜로 이동한다.
//  선별 단계의 excludeKeys가 애초에 그런 재선택을 막는다).

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** KST(UTC+9) 기준 'YYYY-MM-DD'. 배치 실행일 계산용(§5 pick_date). */
export function kstDateString(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

export function openDb(path = 'daily-digest.db') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  return db;
}

/** 기존 DB에 신규 컬럼을 멱등적으로 추가한다(누적 DB가 스키마 변경을 따라가도록). */
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(daily_picks)').all().map(r => r.name));
  const addColumn = (name, type) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE daily_picks ADD COLUMN ${name} ${type}`);
  };
  addColumn('detail_translation', 'TEXT');
  addColumn('detail_summary', 'TEXT');
  addColumn('detail_blog', 'TEXT');
  // 백필 처리 시각: 결과가 비어도 재처리(재과금)하지 않도록 표시용
  addColumn('backfilled_at', 'TEXT');
}

/**
 * 하루치 선별·번역 결과를 저장한다. 트랜잭션으로 picks + dedup_log를 함께 적재.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} payload
 * @param {string} payload.pickDate           'YYYY-MM-DD'(KST)
 * @param {object[]} payload.items            translateAll 결과(순서 = rank)
 * @param {object[]} payload.dedupLog         selectDaily 결과 dedupLog
 * @returns {{ inserted: number, updated: number, removed: number, dedupRows: number }}
 */
export function savePicks(db, { pickDate, items, dedupLog = [] }) {
  const upsert = db.prepare(`
    INSERT INTO daily_picks (
      pick_date, source, source_item_id, title_original, title_ko,
      summary_original, summary_ko, url, popularity_signal, published_at,
      selection_reason, is_translated, rank,
      detail_translation, detail_summary, detail_blog
    ) VALUES (
      $pick_date, $source, $source_item_id, $title_original, $title_ko,
      $summary_original, $summary_ko, $url, $popularity_signal, $published_at,
      $selection_reason, $is_translated, $rank,
      $detail_translation, $detail_summary, $detail_blog
    )
    ON CONFLICT(source, source_item_id) DO UPDATE SET
      pick_date = excluded.pick_date,
      title_ko = excluded.title_ko,
      summary_ko = excluded.summary_ko,
      popularity_signal = excluded.popularity_signal,
      selection_reason = excluded.selection_reason,
      is_translated = excluded.is_translated,
      rank = excluded.rank,
      -- 새로 생성됐을 때만 덮어쓰고, 이번 실행에서 NULL이면 기존 값을 보존
      detail_translation = COALESCE(excluded.detail_translation, daily_picks.detail_translation),
      detail_summary = COALESCE(excluded.detail_summary, daily_picks.detail_summary),
      detail_blog = COALESCE(excluded.detail_blog, daily_picks.detail_blog)
  `);
  const insertDedup = db.prepare(`
    INSERT INTO dedup_log (
      pick_date, kept_source, kept_item_id, dropped_source, dropped_title, method, similarity_score
    ) VALUES ($pick_date, $kept_source, $kept_item_id, $dropped_source, $dropped_title, $method, $similarity_score)
  `);

  let inserted = 0, updated = 0, removed = 0;
  db.exec('BEGIN');
  try {
    // 같은 날 재실행 멱등성: 이 날짜의 기존 픽·dedup_log를 먼저 비우고 다시 채운다.
    // (지우지 않으면 재실행에서 픽이 바뀔 때 옛 행이 남아 그날 건수와 순번이 어긋난다)
    const prevKeys = new Set(
      db.prepare('SELECT source, source_item_id FROM daily_picks WHERE pick_date = ?').all(pickDate)
        .map(r => `${r.source}|${r.source_item_id}`),
    );
    db.prepare('DELETE FROM daily_picks WHERE pick_date = ?').run(pickDate);
    db.prepare('DELETE FROM dedup_log WHERE pick_date = ?').run(pickDate);

    for (const [i, c] of items.entries()) {
      const before = prevKeys.has(`${c.source}|${c.sourceItemId}`);
      if (before) prevKeys.delete(`${c.source}|${c.sourceItemId}`);
      upsert.run({
        pick_date: pickDate,
        source: c.source,
        source_item_id: c.sourceItemId,
        title_original: c.title,
        title_ko: c.titleKo ?? c.title,
        summary_original: c.summary ?? null,
        summary_ko: c.summaryKo ?? null,
        url: c.url,
        popularity_signal: c.popularitySignal ?? null,
        published_at: c.publishedAt ?? null,
        selection_reason: c.selectionReason ?? 'primary',
        is_translated: c.isTranslated ? 1 : 0,
        rank: i + 1,
        detail_translation: c.detailTranslation ?? null,
        detail_summary: c.detailSummary ?? null,
        detail_blog: c.detailBlog ?? null,
      });
      if (before) updated++; else inserted++;
    }
    removed = prevKeys.size; // 재실행에서 더 이상 선택되지 않아 빠진 항목

    for (const l of dedupLog) {
      insertDedup.run({
        pick_date: pickDate,
        kept_source: l.keptSource,
        kept_item_id: l.keptItemId,
        dropped_source: l.droppedSource,
        dropped_title: l.droppedTitle,
        method: l.method,
        similarity_score: l.similarityScore ?? null,
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { inserted, updated, removed, dedupRows: dedupLog.length };
}

// 한국어 콘텐츠가 덜 채워진 행: 상세 3구성 중 하나라도 비었거나, 번역 대상인데 번역이 안 됐다.
// GeekNews는 이미 한국어라 정제만 하고 is_translated=0으로 남으므로(§0) 번역 조건에서 뺀다.
// (예전엔 is_translated=0만 봐서 다 채워진 GeekNews 행까지 매번 다시 과금했다)
const INCOMPLETE = `(detail_translation IS NULL OR detail_summary IS NULL OR detail_blog IS NULL
  OR (is_translated = 0 AND source <> 'geeknews'))`;

/**
 * 백필 대상 행을 반환한다. 한국어 콘텐츠가 덜 채워졌고, 아직 백필하지 않은 항목.
 * @param {object} [filter] { date, source, limit }
 */
export function getBackfillTargets(db, { date = null, source = null, limit = 50 } = {}) {
  const where = ['backfilled_at IS NULL', INCOMPLETE];
  const params = [];
  if (date) { where.push('pick_date = ?'); params.push(date); }
  if (source) { where.push('source = ?'); params.push(source); }
  return db.prepare(
    `SELECT id, pick_date, source, source_item_id, title_original, summary_original, url, published_at
     FROM daily_picks WHERE ${where.join(' AND ')} ORDER BY pick_date DESC, rank ASC LIMIT ?`,
  ).all(...params, limit);
}

/**
 * 백필 결과를 해당 행에만 반영한다.
 * savePicks는 그날 행을 전부 지우고 다시 넣으므로 행 단위 갱신에 쓰면 안 된다.
 */
export function updateItemContent(db, id, {
  titleKo, summaryKo, isTranslated, detailTranslation, detailSummary, detailBlog,
}) {
  db.prepare(`
    UPDATE daily_picks SET
      title_ko = COALESCE(?, title_ko),
      summary_ko = COALESCE(?, summary_ko),
      is_translated = ?,
      detail_translation = COALESCE(?, detail_translation),
      detail_summary = COALESCE(?, detail_summary),
      detail_blog = COALESCE(?, detail_blog),
      backfilled_at = datetime('now')
    WHERE id = ?
  `).run(
    titleKo ?? null, summaryKo ?? null, isTranslated ? 1 : 0,
    detailTranslation ?? null, detailSummary ?? null, detailBlog ?? null, id,
  );
}

/**
 * 덜 채워진 채 처리 완료로 표시된 행의 backfilled_at을 지운다.
 *
 * 백필은 LLM이 실패해도 throw하지 않고 원문 폴백하는데, 그 경우에도 backfilled_at이
 * 찍혀 다음 실행에서 영영 건너뛴다. 응답 잘림·rate limit 같은 일시적 실패까지
 * 영구 포기가 되므로, 결과가 비었거나 일부만 나온 행을 골라 다시 대상으로 돌린다.
 * (재실행 시 기존 값은 COALESCE로 보존되고, 새로 나온 값만 채워진다)
 * @returns {number} 되돌린 행 수
 */
export function resetIncompleteBackfills(db) {
  const { changes } = db.prepare(
    `UPDATE daily_picks SET backfilled_at = NULL WHERE backfilled_at IS NOT NULL AND ${INCOMPLETE}`,
  ).run();
  return Number(changes);
}

/**
 * 이미 게시된 항목 키(`source|source_item_id`) 집합을 반환한다.
 * exceptDate를 지정하면 그 날짜의 픽은 제외: 같은 날 재실행(workflow_dispatch)이
 * 자기 자신 때문에 후보를 잃지 않도록(멱등) 하기 위함.
 * @returns {Set<string>}
 */
export function getPickedItemKeys(db, { exceptDate = null } = {}) {
  const rows = exceptDate
    ? db.prepare('SELECT source, source_item_id FROM daily_picks WHERE pick_date <> ?').all(exceptDate)
    : db.prepare('SELECT source, source_item_id FROM daily_picks').all();
  return new Set(rows.map(r => `${r.source}|${r.source_item_id}`));
}

/** 저장된 날짜 목록(최신순)과 각 날짜 건수: 아카이브 뷰(§7)용 */
export function listDates(db) {
  return db.prepare(
    'SELECT pick_date AS date, COUNT(*) AS count FROM daily_picks GROUP BY pick_date ORDER BY pick_date DESC',
  ).all();
}

/** 특정 날짜의 선별 결과(rank 순) */
export function getPicksByDate(db, date) {
  return db.prepare('SELECT * FROM daily_picks WHERE pick_date = ? ORDER BY rank ASC').all(date);
}

/** 가장 최근 날짜(없으면 null) */
export function latestDate(db) {
  return db.prepare('SELECT pick_date FROM daily_picks ORDER BY pick_date DESC LIMIT 1').get()?.pick_date ?? null;
}
