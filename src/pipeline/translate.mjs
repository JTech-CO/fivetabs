// 번역 파이프라인 (기술 백서 §4)
//
// 원칙(§4.1): 제목 + 요약(초록/RSS description)만 번역, 원문 링크는 항상 노출.
// GeekNews(§0)는 이미 한국어이므로 "번역"이 아니라 맞춤법·표기 정제만 → is_translated=0.
// 나머지 4개 소스는 영어 원문이므로 정식 번역 → is_translated=1.
//
// 모델: llm.mjs가 선택한 프로바이더(Anthropic/OpenAI/Grok/Gemini)의 상위-빠른 모델.
// 어떤 프로바이더 키도 없으면 원문을 그대로 두고 is_translated=0.
// JSON 파싱 실패 시에도 원문 폴백: 파이프라인이 죽지 않는다(§9). 실패율은 반환값에 집계.

import { askLlmJSON, hasLlm, objectSchema } from './llm.mjs';

// §4.2: 고유명사·전문용어 오역 방지 사전. 자주 등장하는 항목을 점진적으로 누적한다.
const GLOSSARY = [
  'LLM=LLM', 'transformer=트랜스포머', 'benchmark=벤치마크', 'fine-tuning=파인튜닝',
  'inference=추론', 'embedding=임베딩', 'quantization=양자화', 'agent=에이전트',
  'open-source=오픈소스', 'superconductivity=초전도', 'antiferromagnet=반강자성체',
].join(', ');

const TRANSLATE_SYSTEM =
  '너는 기술/과학 뉴스 번역가다. 제목과 요약을 사실관계 왜곡 없이 자연스러운 한국어로 번역한다. '
  + '고유명사(회사·모델·인명)와 학술 용어는 원어 병기 또는 통용 표기를 따른다. '
  + `용어 사전: ${GLOSSARY}. `
  + '출력은 JSON만: {"title_ko": "...", "summary_ko": "..."} (요약이 없으면 summary_ko는 null).';

const REFINE_SYSTEM =
  '너는 한국어 교정가다. 입력은 이미 한국어인 기술 뉴스 제목과 요약이다. '
  + '의미를 바꾸지 말고 맞춤법·띄어쓰기·표기만 자연스럽게 정제한다. '
  + '출력은 JSON만: {"title_ko": "...", "summary_ko": "..."} (요약이 없으면 summary_ko는 null).';

/**
 * 선별된 항목 1건을 번역/정제해 title_ko·summary_ko·isTranslated를 부여한 새 객체를 반환한다.
 * 실패 시 원문 폴백({ ...item, titleKo: title, summaryKo: summary, isTranslated: false, translateError }).
 *
 * @param {object} item  selectDaily가 반환한 order 항목
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {boolean} [options.forceRefine]  GeekNews 여부와 무관하게 정제 모드 강제(테스트용)
 */
export async function translateItem(item, { fetchImpl = fetch, forceRefine } = {}) {
  const isGeekNews = item.source === 'geeknews';
  const refineOnly = forceRefine ?? isGeekNews;

  // 키가 없으면 원문 유지(§0/§4.2 fallback)
  if (!hasLlm()) {
    return { ...item, titleKo: item.title, summaryKo: item.summary, isTranslated: false, translateSkipped: true };
  }

  const user = `제목: ${item.title}\n요약: ${item.summary ?? '(없음)'}`;
  try {
    const out = await askLlmJSON({
      fetchImpl,
      system: refineOnly ? REFINE_SYSTEM : TRANSLATE_SYSTEM,
      user,
      // 초록 전문을 한국어로 옮기므로 넉넉히. arXiv 초록(~1.8k자)이 600에서 잘려
      // 조용히 원문 폴백되던 문제가 있었다.
      maxTokens: 2000,
      schema: objectSchema({ title_ko: 'string', summary_ko: 'string?' }),
    });
    const titleKo = typeof out.title_ko === 'string' && out.title_ko.trim() ? out.title_ko.trim() : item.title;
    const summaryKo = typeof out.summary_ko === 'string' && out.summary_ko.trim() ? out.summary_ko.trim() : null;
    return {
      ...item,
      titleKo,
      summaryKo,
      // 정제 전용(GeekNews)은 번역이 아니므로 is_translated=0 (§0)
      isTranslated: !refineOnly,
    };
  } catch (err) {
    return { ...item, titleKo: item.title, summaryKo: item.summary, isTranslated: false, translateError: err.message };
  }
}

/**
 * 선별 목록 전체를 번역한다. JSON 파싱 실패율을 함께 집계(§10 M3 DoD).
 * @param {object[]} order
 * @param {object} [options]
 * @returns {Promise<{ items: object[], stats: { total, translated, refined, skipped, failed, failureRate } }>}
 */
export async function translateAll(order, options = {}) {
  const items = [];
  for (const item of order) {
    items.push(await translateItem(item, options));
  }
  const failed = items.filter(i => i.translateError).length;
  const translated = items.filter(i => i.isTranslated).length;
  // LLM이 실제로 돌았을 때만 "정제"로 센다. 키가 없어 건너뛴 건은 skipped
  const skipped = items.filter(i => i.translateSkipped).length;
  const refined = items.filter(
    i => !i.isTranslated && !i.translateError && !i.translateSkipped && i.source === 'geeknews',
  ).length;
  return {
    items,
    stats: {
      total: items.length,
      translated,
      refined,
      skipped,
      failed,
      failureRate: items.length ? failed / items.length : 0,
    },
  };
}
