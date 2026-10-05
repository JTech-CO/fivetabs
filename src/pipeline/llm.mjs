// 멀티 프로바이더 LLM 클라이언트 (기술 백서 §3.2 4차 dedup, §4 번역)
//
// Anthropic / OpenAI / Grok(xAI) / Gemini 중 API 키가 설정된 프로바이더를 자동 선택한다.
// 각 프로바이더의 "최상위이면서 빠른" 모델을 기본값으로 쓰되 env로 override 가능:
//   Anthropic  claude-sonnet-5     (ANTHROPIC_MODEL): Opus 4.8도 사용 가능
//   OpenAI     gpt-5.5             (OPENAI_MODEL)
//   Grok(xAI)  grok-4.3           (XAI_MODEL)
//   Gemini     gemini-3.5-flash   (GEMINI_MODEL)
//
// 키가 여럿이면 LLM_PROVIDER로 명시하거나, 없으면 PRIORITY 순서로 첫 키를 쓴다.
// 모델 ID는 릴리스 시점에 따라 달라질 수 있으므로 위 env로 정정할 수 있게 열어 둔다.

// 각 프로바이더: 키 탐색 → 요청 조립(build) → 응답 텍스트 추출(extract).
const PROVIDERS = {
  anthropic: {
    name: 'anthropic',
    keys: ['ANTHROPIC_API_KEY'],
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-sonnet-5',
    build({ apiKey, model, system, user, maxTokens, schema }) {
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: {
          model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
          // 다른 프로바이더의 JSON 모드에 해당. 이게 없으면 긴 한국어 본문 속 따옴표를
          // 이스케이프하지 않은 응답이 섞여 나와 10/5 백필에서 161건 중 28건이 파싱에 실패했다.
          // (지원 모델: Sonnet 5 / 5.5, Opus 4.8 이상, Haiku 4.5 등)
          ...(schema && { output_config: { format: { type: 'json_schema', schema } } }),
        },
      };
    },
    extract: data => (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(''),
    truncated: data => data.stop_reason === 'max_tokens',
    refused: data => data.stop_reason === 'refusal',
  },

  openai: {
    name: 'openai',
    keys: ['OPENAI_API_KEY'],
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-5.5',
    build({ apiKey, model, system, user, maxTokens }) {
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: {
          model,
          max_completion_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        },
      };
    },
    extract: data => data.choices?.[0]?.message?.content ?? '',
    truncated: data => data.choices?.[0]?.finish_reason === 'length',
  },

  grok: {
    name: 'grok',
    keys: ['XAI_API_KEY', 'GROK_API_KEY'],
    modelEnv: 'XAI_MODEL',
    defaultModel: 'grok-4.3',
    build({ apiKey, model, system, user, maxTokens }) {
      // xAI는 OpenAI 호환 API
      return {
        url: 'https://api.x.ai/v1/chat/completions',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: {
          model,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        },
      };
    },
    extract: data => data.choices?.[0]?.message?.content ?? '',
    truncated: data => data.choices?.[0]?.finish_reason === 'length',
  },

  gemini: {
    name: 'gemini',
    keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-3.5-flash',
    build({ apiKey, model, system, user, maxTokens }) {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: {
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
        },
      };
    },
    extract: data => (data.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join(''),
    truncated: data => data.candidates?.[0]?.finishReason === 'MAX_TOKENS',
  },
};

// 키가 여럿일 때의 기본 우선순위(LLM_PROVIDER로 명시 override 가능)
const PRIORITY = ['anthropic', 'openai', 'gemini', 'grok'];

function keyFor(provider) {
  for (const k of provider.keys) {
    if (process.env[k]) return process.env[k];
  }
  return null;
}

/** 현재 활성 프로바이더 객체(없으면 null). LLM_PROVIDER가 지정되면 그 프로바이더만 고려. */
export function activeProvider() {
  const forced = process.env.LLM_PROVIDER;
  if (forced) {
    const p = PROVIDERS[forced.toLowerCase()];
    return p && keyFor(p) ? p : null;
  }
  for (const name of PRIORITY) {
    if (keyFor(PROVIDERS[name])) return PROVIDERS[name];
  }
  return null;
}

export function hasLlm() {
  return activeProvider() !== null;
}

/** 활성 프로바이더 이름·모델(로그용). 키 없으면 null. */
export function activeProviderInfo() {
  const p = activeProvider();
  if (!p) return null;
  return { name: p.name, model: process.env[p.modelEnv] || p.defaultModel };
}

/**
 * 문자열(또는 불리언) 필드만 있는 평평한 객체의 JSON 스키마.
 * 필드 타입: 'string' | 'string?'(null 허용) | 'boolean'
 * @param {Record<string, 'string'|'string?'|'boolean'>} fields
 */
export function objectSchema(fields) {
  const TYPES = {
    string: { type: 'string' },
    'string?': { anyOf: [{ type: 'string' }, { type: 'null' }] },
    boolean: { type: 'boolean' },
  };
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(fields).map(([k, t]) => [k, TYPES[t]])),
    required: Object.keys(fields),
    additionalProperties: false,
  };
}

/**
 * 활성 프로바이더로 system+user 프롬프트를 보내 JSON 응답을 파싱해 반환한다.
 * 프로바이더별 응답 형태 차이를 extract()로 흡수하고, 코드펜스 감싸기까지 처리한다.
 * schema를 주면 Anthropic은 그 스키마로 출력을 강제한다(나머지는 각자의 JSON 모드).
 */
export async function askLlmJSON({ system, user, maxTokens = 600, schema = null, fetchImpl = fetch }) {
  const p = activeProvider();
  if (!p) throw new Error('[llm] 사용 가능한 API 키가 없음 (ANTHROPIC/OPENAI/XAI/GEMINI)');

  const apiKey = keyFor(p);
  const model = process.env[p.modelEnv] || p.defaultModel;
  const { url, headers, body } = p.build({ apiKey, model, system, user, maxTokens, schema });

  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`[llm:${p.name}] API 오류 ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  // 출력이 maxTokens에서 끊기면 JSON이 미완성이라 파싱이 실패한다. 그걸 "파싱 실패"로
  // 뭉뚱그리면 상한이 모자란 건지 모델이 헛소리를 한 건지 구분할 수 없어, 따로 보고한다.
  if (p.truncated?.(data)) {
    throw new Error(`[llm:${p.name}] 응답이 maxTokens(${maxTokens})에서 잘렸습니다. 상한을 올리세요.`);
  }
  if (p.refused?.(data)) {
    throw new Error(`[llm:${p.name}] 모델이 응답을 거부했습니다(${data.stop_details?.category ?? '분류 없음'}).`);
  }
  const text = p.extract(data);
  try {
    return parseLooseJson(text);
  } catch (cause) {
    // 앞 200자만 찍으면 대개 멀쩡해 보인다. 깨진 곳은 뒤쪽이라 꼬리도 함께 남긴다.
    throw new Error(`[llm:${p.name}] JSON 파싱 실패: ${excerpt(text)}`, { cause });
  }
}

const excerpt = t => (t.length <= 500 ? t : `${t.slice(0, 300)} …(${t.length}자 중 생략)… ${t.slice(-200)}`);

/**
 * LLM이 돌려준 텍스트에서 JSON을 최대한 살려 파싱한다.
 *
 * 모델은 JSON만 내라고 해도 코드펜스로 감싸거나(닫는 펜스를 빠뜨리기도 한다) 앞뒤에
 * 한 줄 덧붙이고, 긴 번역문을 넣을 때 문자열 안에 날것 줄바꿈을 흘린다. 그대로
 * JSON.parse에 넘기면 멀쩡한 응답이 통째로 버려진다.
 */
export function parseLooseJson(text) {
  let s = String(text ?? '').trim()
    .replace(/^```(?:json)?[ \t]*\r?\n?/i, '')   // 여는 펜스(닫는 게 없어도 벗긴다)
    .replace(/\r?\n?```$/, '');                  // 닫는 펜스
  const open = s.indexOf('{');
  const close = s.lastIndexOf('}');
  if (open >= 0 && close > open) s = s.slice(open, close + 1);   // 앞뒤 잡담 제거

  try {
    return JSON.parse(s);
  } catch {
    return JSON.parse(escapeRawControls(s));    // 그래도 안 되면 throw(호출부가 폴백한다)
  }
}

/** JSON 문자열 리터럴 안의 날것 제어문자를 escape한다(바깥은 건드리지 않는다). */
function escapeRawControls(s) {
  const ESCAPED = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    out += inString && ESCAPED[ch] ? ESCAPED[ch] : ch;
  }
  return out;
}

/**
 * 4차 dedup용 "같은 소식인가" 이진 분류기(§3.2).
 * 키가 없으면 null: 호출부는 애매 구간을 비중복으로 처리한다.
 * @returns {null | ((a: object, b: object) => Promise<boolean>)}
 */
export function makeLlmPairClassifier({ fetchImpl = fetch } = {}) {
  if (!hasLlm()) return null;
  return async (a, b) => {
    const result = await askLlmJSON({
      fetchImpl,
      maxTokens: 100,
      schema: objectSchema({ duplicate: 'boolean' }),
      system: '두 기사가 같은 소식(같은 사건/발표/논문)을 다루는지 판정한다. '
        + '언어가 달라도 내용이 같으면 같은 소식이다. 출력은 JSON만: {"duplicate": true|false}',
      user: `A: [${a.source}] ${a.title}\n${a.summary?.slice(0, 300) ?? ''}\n\n`
        + `B: [${b.source}] ${b.title}\n${b.summary?.slice(0, 300) ?? ''}`,
    });
    return result.duplicate === true;
  };
}
