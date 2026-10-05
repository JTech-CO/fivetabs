// 과거 항목 한국어 백필: 이미 저장된 행의 번역·상세를 소급 생성한다.
//
// 왜 필요한가: run.mjs는 24h 수집 창의 신규 후보만 처리하고, getPickedItemKeys가
// 과거 픽을 후보에서 오히려 제외한다. 따라서 LLM 키를 뒤늦게 설정해도 과거 행은
// 영원히 원문(영어)으로 남는다. 이 스크립트만이 그걸 되돌린다.
//
// 사용법:
//   node --env-file-if-exists=.env src/pipeline/backfill.mjs [--limit=20] [--date=2026-08-01] [--source=arxiv] [--dry] [--retry-empty]
//
// LLM 호출이 항목당 1~2회라 비용·시간이 크다. --limit으로 나눠 돌리는 것을 전제로 한다.
// 처리한 행은 backfilled_at이 찍혀 재실행해도 다시 과금되지 않는다.

import { pathToFileURL } from 'node:url';
import { openDb, getBackfillTargets, updateItemContent, resetIncompleteBackfills } from '../db/index.mjs';
import { translateItem } from './translate.mjs';
import { generateDetail } from './detail.mjs';
import { hasLlm, activeProviderInfo } from './llm.mjs';

function parseArgs(argv) {
  const opts = { limit: 20, date: null, source: null, dry: false, retryEmpty: false, dbPath: 'daily-digest.db' };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'limit') opts.limit = Number(v);
    else if (k === 'date') opts.date = v;
    else if (k === 'source') opts.source = v;
    else if (k === 'dry') opts.dry = true;
    else if (k === 'retry-empty') opts.retryEmpty = true;
    else if (k === 'db') opts.dbPath = v;
  }
  return opts;
}

// 크레딧 소진(400)·키 무효(401/403)·요청 형식 오류(400)는 다음 행에서도 똑같이 실패한다.
// 계속 돌면 남은 행이 전부 "빈 결과"로 찍혀 버리므로(실측: 9/25 배치 2~4가 293건을
// 그렇게 소모) 거기서 멈춘다. 일시 오류(429·5xx)와 행별 파싱 실패는 계속 진행한다.
const FATAL_LLM_ERROR = /API 오류 40[013]|insufficient_quota/;

/** DB 행 → 파이프라인이 쓰는 Candidate 형태로 복원 */
const toCandidate = row => ({
  source: row.source,
  sourceItemId: row.source_item_id,
  title: row.title_original,
  summary: row.summary_original,
  url: row.url,
  publishedAt: row.published_at,
});

export async function runBackfill(opts) {
  const { limit, date, source, dry, retryEmpty, dbPath } = opts;
  const db = openDb(dbPath);
  try {
    if (retryEmpty && !dry) {
      const reset = resetIncompleteBackfills(db);
      console.log(`[backfill] 결과가 비었거나 일부만 나온 행 ${reset}건을 대상으로 되돌림`);
    }
    const targets = getBackfillTargets(db, { date, source, limit });
    const provider = activeProviderInfo();
    console.log(`[backfill] 대상 ${targets.length}건 (limit ${limit}`
      + `${date ? `, date ${date}` : ''}${source ? `, source ${source}` : ''})`);
    console.log(`[backfill] LLM: ${provider ? `${provider.name} (${provider.model})` : 'OFF'}`);

    if (dry) {
      for (const t of targets) console.log(`  - ${t.pick_date} ${t.source.padEnd(11)} ${t.title_original.slice(0, 60)}`);
      return { total: targets.length, translated: 0, detailed: 0, skipped: 0, dryRun: true };
    }
    if (!hasLlm()) {
      console.error('[backfill] LLM 키가 없습니다. .env 또는 환경변수를 설정하세요.');
      return { total: targets.length, translated: 0, detailed: 0, skipped: targets.length };
    }

    let translated = 0, detailed = 0, skipped = 0;
    for (const [i, row] of targets.entries()) {
      const item = toCandidate(row);
      const label = `${row.pick_date} ${row.source}`;
      try {
        const t = await translateItem(item);
        const d = await generateDetail(item);
        const fatal = [t.translateError, d.detailError].find(e => FATAL_LLM_ERROR.test(e ?? ''));
        if (fatal) {
          // 이 행은 기록하지 않는다(backfilled_at이 비어 다음 실행에서 그대로 대상이 된다)
          console.error(`[backfill] LLM을 쓸 수 없어 중단합니다(${i}/${targets.length}건 처리): ${fatal}`);
          return { total: targets.length, translated, detailed, skipped, aborted: true };
        }
        const gotTranslation = t.titleKo && t.titleKo !== item.title;
        const gotDetail = Boolean(d.summary || d.translation || d.blog);
        if (gotTranslation) translated++;
        if (gotDetail) detailed++;
        if (!gotTranslation && !gotDetail) skipped++;

        updateItemContent(db, row.id, {
          titleKo: t.titleKo,
          summaryKo: t.summaryKo,
          isTranslated: t.isTranslated,
          detailTranslation: d.translation,
          detailSummary: d.summary,
          detailBlog: d.blog,
        });
        console.log(`  [${i + 1}/${targets.length}] ${label}: `
          + `번역 ${gotTranslation ? 'O' : '-'} / 상세 ${gotDetail ? 'O' : '-'}`
          + `${d.usedFullText ? ' (전문)' : ''}`);
        // 두 함수는 실패해도 throw하지 않고 원문 폴백한다. 사유를 찍지 않으면
        // CI 로그에 '-'만 남아 왜 비었는지 알 수 없다.
        if (t.translateError) console.error(`      번역 실패: ${t.translateError}`);
        if (d.detailError) console.error(`      상세 실패: ${d.detailError}`);
      } catch (err) {
        skipped++;
        console.error(`  [${i + 1}/${targets.length}] ${label} 실패: ${err.message}`);
      }
    }
    console.log(`[backfill] 완료: 번역 ${translated} / 상세 ${detailed} / 스킵 ${skipped}`);
    return { total: targets.length, translated, detailed, skipped };
  } finally {
    db.close();
  }
}

// CLI로 직접 실행될 때만 동작(테스트에서 import 가능하도록).
// 경로에 한글·공백이 있으면 import.meta.url은 퍼센트 인코딩되므로 pathToFileURL로 맞춘다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runBackfill(parseArgs(process.argv.slice(2)));
  if (result.aborted) process.exitCode = 1;   // CI가 빨갛게 보이도록(커밋 스텝은 그래도 돈다)
}
