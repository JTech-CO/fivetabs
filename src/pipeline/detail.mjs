// 상세 뷰 콘텐츠 생성 (제목/패널 클릭 시 여는 창): 파이프라인(서버) 전용
//
// 사용자 선택: 상세 3구성을 기사 "전문(full article)" 기반으로 생성한다(#4/#6).
// 서버 사이드는 CORS가 없으므로 기사 원문을 직접 가져와(extractArticleText) 전문을 확보한다.
//   hackernews/physorg/techxplore: 기사 원문을 가져와 전문 추출(실패 시 초록 폴백)
//   arxiv                         : 초록이 곧 콘텐츠(전문=PDF는 범위 밖) → 초록 기반
//   geeknews                      : 이미 한국어 → 정제만(§0)
//
// 전문은 길어 번역 출력이 잘리지 않도록 번역을 별도 호출로 분리한다(요약+블로그는 1콜).
// LLM 키가 없으면 전부 null. 실패 시에도 null(+detailError)로 파이프라인 무중단.

import { fetchText } from '../adapters/http.mjs';
import { extractArticleText } from './extract.mjs';
import { askLlmJSON, hasLlm, objectSchema } from './llm.mjs';

const FULLTEXT_SOURCES = new Set(['hackernews', 'physorg', 'techxplore']);
const MIN_FULLTEXT_CHARS = 400; // 이보다 짧으면 추출 실패로 보고 초록 폴백

// 기사 본문이 아니라 토론 스레드인 페이지: 전문 추출 대상에서 제외한다.
// (HN 셀프포스트(Ask/Show HN)는 url이 HN 아이템 페이지라, 추출하면 본문 대신
//  댓글 수백 개가 "전문"으로 잡혀 댓글을 기사로 번역하게 된다. 실측 확인됨.
//  이 경우 게시물 본문은 어댑터가 이미 summary(story_text)에 담아 둔다.)
const DISCUSSION_HOSTS = new Set(['news.ycombinator.com', 'news.hada.io']);

function isDiscussionPage(url) {
  try {
    return DISCUSSION_HOSTS.has(new URL(url).hostname.replace(/^www\./, ''));
  } catch {
    return false;
  }
}

const NO_FABRICATION = '네비게이션·편집자 정보·"fact-checked" 같은 메타데이터는 무시하고 기사 본문만 대상으로 하며, 주어진 범위를 넘어 없는 사실을 지어내지 마라.';

// 전문 기반
const SYS_TRANSLATE_FULL =
  '너는 기술/과학 번역가다. 입력은 기사 제목과 본문(전문)이다. 본문 전체를 요약하지 말고 '
  + `자연스럽고 충실한 한국어로 전문 번역하라. ${NO_FABRICATION} 출력은 JSON만: {"translation":"..."}`;
const SYS_SUMMARY_BLOG_FULL =
  '너는 기술 콘텐츠 에디터다. 입력은 기사 제목과 본문(전문)이다. 본문 전체를 반영해 한국어로 생성하라: '
  + 'summary(핵심을 3~6문장 한두 문단), blog(기술 블로그 글 초안: 마크다운으로 제안 제목 # 한 줄, 도입 문단, '
  + `핵심 포인트 불릿, 짧은 시사점). ${NO_FABRICATION} 출력은 JSON만: {"summary":"...","blog":"..."}`;

// 초록 기반(arxiv 또는 전문 추출 실패): 3구성 1콜
const SYS_TRANSLATE_SHORT =
  '너는 기술/과학 콘텐츠 에디터다. 입력은 기사 제목과 요약(초록/발췌)이며 전체 본문이 아니다. '
  + '한국어로 translation(제목·요약을 충실히 번역), summary(핵심 3~6문장), blog(기술 블로그 초안, 마크다운)을 생성하라. '
  + '출력은 JSON만: {"translation":"...","summary":"...","blog":"..."}';
// 정제(geeknews): 이미 한국어
const SYS_REFINE =
  '너는 한국어 기술 콘텐츠 에디터다. 입력은 이미 한국어인 기술 뉴스의 제목과 요약이다. '
  + 'translation(원문을 맞춤법·표기만 정제), summary(핵심 3~6문장), blog(기술 블로그 초안)을 생성하라. '
  + '출력은 JSON만: {"translation":"...","summary":"...","blog":"..."}';

const SCHEMA_TRANSLATION = objectSchema({ translation: 'string' });
const SCHEMA_SUMMARY_BLOG = objectSchema({ summary: 'string', blog: 'string' });
const SCHEMA_ALL = objectSchema({ translation: 'string', summary: 'string', blog: 'string' });

const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const nulls = extra => ({ translation: null, summary: null, blog: null, ...extra });

/**
 * 항목 1건의 상세 3구성을 생성한다. 키 없음/실패 시 전부 null(+detailError).
 * @returns {Promise<{translation:string|null, summary:string|null, blog:string|null, usedFullText?:boolean, detailError?:string}>}
 */
export async function generateDetail(item, { fetchImpl = fetch, forceRefine } = {}) {
  if (!hasLlm()) return nulls();
  const refineOnly = forceRefine ?? item.source === 'geeknews';
  if (refineOnly) return generateFromShort(item, SYS_REFINE, { fetchImpl, usedFullText: false });

  // 전문 확보 시도(해당 소스만, 토론 페이지는 제외)
  if (FULLTEXT_SOURCES.has(item.source) && !isDiscussionPage(item.url)) {
    let fullText = null;
    try {
      const html = await fetchText(item.source, item.url, { fetchImpl });
      const text = extractArticleText(html);
      if (text.length >= MIN_FULLTEXT_CHARS) fullText = text;
    } catch { /* 전문 실패 → 초록 폴백 */ }
    if (fullText) return generateFromFull(item, fullText, { fetchImpl });
  }

  // 전문도 요약도 없으면 생성하지 않는다. 제목만으로는 LLM이 내용을 지어낸다.
  // (HN 스토리 중 story_text가 없는 외부 링크 항목이 여기 해당)
  if (!item.summary || !String(item.summary).trim()) {
    return nulls({ usedFullText: false });
  }

  // 초록 기반(arxiv 또는 전문 추출 실패)
  return generateFromShort(item, SYS_TRANSLATE_SHORT, { fetchImpl, usedFullText: false });
}

// 전문: 번역(길어서 별도 콜, 큰 토큰) + 요약·블로그(1콜)
//
// 두 콜은 따로 실패를 받는다. 긴 기사는 번역만 상한에서 잘리는 일이 잦은데, 한 try로
// 묶으면 멀쩡히 나온 요약·블로그까지 같이 버려진다.
async function generateFromFull(item, fullText, { fetchImpl }) {
  const user = `제목: ${item.title}\n본문:\n${fullText}`;
  const errors = [];
  const ask = (label, maxTokens, system, schema) => askLlmJSON({ fetchImpl, maxTokens, system, user, schema })
    .catch(err => { errors.push(`${label}: ${err.message}`); return {}; });

  // 본문 상한 12000자(extract.mjs)의 한국어 번역은 8000토큰 근처까지 간다. 사고 토큰도
  // 상한에 포함되므로 여유를 둔다(실제 과금은 쓴 만큼이다).
  const t = await ask('번역', 16000, SYS_TRANSLATE_FULL, SCHEMA_TRANSLATION);
  const sb = await ask('요약·블로그', 8000, SYS_SUMMARY_BLOG_FULL, SCHEMA_SUMMARY_BLOG);
  const out = { translation: str(t.translation), summary: str(sb.summary), blog: str(sb.blog), usedFullText: true };
  return errors.length ? { ...out, detailError: errors.join(' / ') } : out;
}

// 초록/정제: 3구성 1콜
async function generateFromShort(item, system, { fetchImpl, usedFullText }) {
  const user = `출처: ${item.source}\n제목: ${item.title}\n요약: ${item.summary ?? '(요약 없음)'}`;
  try {
    // 번역본+요약+블로그 초안을 한 번에 받으므로 상한이 크다(2000에서 상시 잘렸다)
    const out = await askLlmJSON({ fetchImpl, maxTokens: 8000, system, user, schema: SCHEMA_ALL });
    return { translation: str(out.translation), summary: str(out.summary), blog: str(out.blog), usedFullText };
  } catch (err) {
    return nulls({ usedFullText, detailError: err.message });
  }
}

/**
 * 선별·번역된 항목 목록에 상세 3구성을 붙인다.
 * @returns {Promise<{ items: object[], stats: { total, generated, fullText, failed } }>}
 */
export async function generateDetailsAll(items, options = {}) {
  const out = [];
  let generated = 0, failed = 0, fullText = 0;
  for (const item of items) {
    const d = await generateDetail(item, options);
    // 일부만 나온 경우(번역만 잘림 등)도 화면에 쓸 내용이 있으니 생성으로 센다
    if (d.translation || d.summary || d.blog) generated++;
    else if (d.detailError) failed++;
    if (d.usedFullText && !d.detailError) fullText++;
    if (d.detailError) console.warn(`  [detail] ${item.source}: ${d.detailError}`);
    out.push({ ...item, detailTranslation: d.translation, detailSummary: d.summary, detailBlog: d.blog });
  }
  return { items: out, stats: { total: items.length, generated, fullText, failed } };
}
