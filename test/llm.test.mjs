// 멀티 프로바이더 LLM 클라이언트 검증 (Anthropic/OpenAI/Grok/Gemini)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askLlmJSON, hasLlm, activeProviderInfo, parseLooseJson, objectSchema } from '../src/pipeline/llm.mjs';
import { withEnv, withKey } from './helpers.mjs';

// 요청을 가로채 URL/헤더/바디를 기록하고, 고정 응답을 돌려주는 mock
function captureFetch(responsePayload) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, statusText: 'OK', async json() { return responsePayload; }, async text() { return JSON.stringify(responsePayload); } };
  };
  return { impl, calls };
}

const RESULT = { title_ko: '번역', summary_ko: '요약' };

// 프로바이더별 응답 형태
const shape = {
  anthropic: { content: [{ type: 'text', text: JSON.stringify(RESULT) }] },
  openai: { choices: [{ message: { content: JSON.stringify(RESULT) } }] },
  grok: { choices: [{ message: { content: JSON.stringify(RESULT) } }] },
  gemini: { candidates: [{ content: { parts: [{ text: JSON.stringify(RESULT) }] } }] },
};

// ── 키 탐지·우선순위 ──────────────────────────────────────────

test('키 없음: hasLlm false, activeProviderInfo null', withEnv({}, () => {
  assert.equal(hasLlm(), false);
  assert.equal(activeProviderInfo(), null);
}));

test('anthropic 키만: sonnet-5 기본 모델', withEnv({ ANTHROPIC_API_KEY: 'k' }, () => {
  assert.deepEqual(activeProviderInfo(), { name: 'anthropic', model: 'claude-sonnet-5' });
}));

test('openai 키만: gpt-5.5 기본 모델', withEnv({ OPENAI_API_KEY: 'k' }, () => {
  assert.deepEqual(activeProviderInfo(), { name: 'openai', model: 'gpt-5.5' });
}));

test('grok 키(XAI_API_KEY): grok-4.3', withEnv({ XAI_API_KEY: 'k' }, () => {
  assert.deepEqual(activeProviderInfo(), { name: 'grok', model: 'grok-4.3' });
}));

test('grok 대체 키(GROK_API_KEY)도 인식', withEnv({ GROK_API_KEY: 'k' }, () => {
  assert.equal(activeProviderInfo()?.name, 'grok');
}));

test('gemini 키: gemini-3.5-flash', withEnv({ GEMINI_API_KEY: 'k' }, () => {
  assert.deepEqual(activeProviderInfo(), { name: 'gemini', model: 'gemini-3.5-flash' });
}));

test('키 여럿이면 우선순위(anthropic 먼저)', withEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' }, () => {
  assert.equal(activeProviderInfo().name, 'anthropic');
}));

test('LLM_PROVIDER로 명시 override', withEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', LLM_PROVIDER: 'openai' }, () => {
  assert.equal(activeProviderInfo().name, 'openai');
}));

test('모델 env override', withEnv({ ANTHROPIC_API_KEY: 'a', ANTHROPIC_MODEL: 'claude-opus-4-8' }, () => {
  assert.equal(activeProviderInfo().model, 'claude-opus-4-8');
}));

// ── 프로바이더별 요청 조립 ────────────────────────────────────

test('anthropic 요청: /v1/messages, x-api-key, system 분리', withEnv({ ANTHROPIC_API_KEY: 'sk-a' }, async () => {
  const { impl, calls } = captureFetch(shape.anthropic);
  const out = await askLlmJSON({ system: 'SYS', user: 'USR', fetchImpl: impl });
  assert.deepEqual(out, RESULT);
  assert.match(calls[0].url, /api\.anthropic\.com\/v1\/messages/);
  assert.equal(calls[0].headers['x-api-key'], 'sk-a');
  assert.equal(calls[0].body.system, 'SYS');
  assert.equal(calls[0].body.messages[0].content, 'USR');
  assert.equal(calls[0].body.model, 'claude-sonnet-5');
}));

test('openai 요청: chat/completions, Bearer, system+user 메시지, json 모드', withEnv({ OPENAI_API_KEY: 'sk-o' }, async () => {
  const { impl, calls } = captureFetch(shape.openai);
  const out = await askLlmJSON({ system: 'SYS', user: 'USR', fetchImpl: impl });
  assert.deepEqual(out, RESULT);
  assert.match(calls[0].url, /api\.openai\.com\/v1\/chat\/completions/);
  assert.equal(calls[0].headers.authorization, 'Bearer sk-o');
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.equal(calls[0].body.messages[1].content, 'USR');
  assert.equal(calls[0].body.response_format.type, 'json_object');
}));

test('grok 요청: api.x.ai, OpenAI 호환 형태', withEnv({ XAI_API_KEY: 'sk-x' }, async () => {
  const { impl, calls } = captureFetch(shape.grok);
  const out = await askLlmJSON({ system: 'SYS', user: 'USR', fetchImpl: impl });
  assert.deepEqual(out, RESULT);
  assert.match(calls[0].url, /api\.x\.ai\/v1\/chat\/completions/);
  assert.equal(calls[0].headers.authorization, 'Bearer sk-x');
  assert.equal(calls[0].body.model, 'grok-4.3');
}));

test('gemini 요청: generateContent, x-goog-api-key, system_instruction/contents', withEnv({ GEMINI_API_KEY: 'sk-g' }, async () => {
  const { impl, calls } = captureFetch(shape.gemini);
  const out = await askLlmJSON({ system: 'SYS', user: 'USR', fetchImpl: impl });
  assert.deepEqual(out, RESULT);
  assert.match(calls[0].url, /gemini-3\.5-flash:generateContent/);
  assert.equal(calls[0].headers['x-goog-api-key'], 'sk-g');
  assert.equal(calls[0].body.system_instruction.parts[0].text, 'SYS');
  assert.equal(calls[0].body.contents[0].parts[0].text, 'USR');
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
}));

// ── 오류·파싱 ─────────────────────────────────────────────────

test('키 없이 askLlmJSON 호출하면 throw', withEnv({}, async () => {
  await assert.rejects(askLlmJSON({ system: 's', user: 'u' }), /사용 가능한 API 키가 없음/);
}));

test('API 오류는 프로바이더명 포함해 throw', withEnv({ OPENAI_API_KEY: 'k' }, async () => {
  const impl = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', async text() { return 'bad key'; } });
  await assert.rejects(askLlmJSON({ system: 's', user: 'u', fetchImpl: impl }), /\[llm:openai\] API 오류 401/);
}));

test('gemini 코드펜스 JSON도 파싱', withEnv({ GEMINI_API_KEY: 'k' }, async () => {
  const fenced = { candidates: [{ content: { parts: [{ text: '```json\n{"title_ko":"제목"}\n```' }] } }] };
  const { impl } = captureFetch(fenced);
  const out = await askLlmJSON({ system: 's', user: 'u', fetchImpl: impl });
  assert.deepEqual(out, { title_ko: '제목' });
}));

// ── 응답 잘림 감지 ───────────────────────────────

const resOf = payload => async () => ({
  ok: true, status: 200, statusText: 'OK',
  async json() { return payload; },
  async text() { return JSON.stringify(payload); },
});

test('잘림: anthropic stop_reason=max_tokens를 파싱 실패가 아니라 잘림으로 보고', withKey(async () => {
  // 회귀: 상한에서 끊긴 JSON을 "파싱 실패"로 뭉뚝그려 원인을 못 찾던 문제
  const truncated = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"title_ko":"잘린' }] };
  await assert.rejects(
    () => askLlmJSON({ system: 's', user: 'u', maxTokens: 600, fetchImpl: resOf(truncated) }),
    /maxTokens\(600\)에서 잘렸/,
  );
}));

test('잘림: 정상 종료는 그대로 파싱', withKey(async () => {
  const ok = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"title_ko":"제목"}' }] };
  assert.deepEqual(await askLlmJSON({ system: 's', user: 'u', fetchImpl: resOf(ok) }), { title_ko: '제목' });
}));

test('거부: anthropic stop_reason=refusal은 파싱 실패가 아니라 거부로 보고', withKey(async () => {
  const refused = { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] };
  await assert.rejects(
    () => askLlmJSON({ system: 's', user: 'u', fetchImpl: resOf(refused) }),
    /응답을 거부했습니다\(cyber\)/,
  );
}));

test('잘림: openai finish_reason=length도 감지', withEnv({ OPENAI_API_KEY: 'k' }, async () => {
  const truncated = { choices: [{ finish_reason: 'length', message: { content: '{"a":' } }] };
  await assert.rejects(
    () => askLlmJSON({ system: 's', user: 'u', fetchImpl: resOf(truncated) }),
    /잘렸/,
  );
}));

// ── 느슨한 JSON 파싱 ───────────────────────────────────────────
// 실제 백필에서 100건 중 7건이 파싱 실패로 버려졌다. 모델이 JSON만 내라고 해도
// 펜스를 씌우거나 문자열 안에 날것 줄바꿈을 흘린다.

test('느슨한 파싱: 평범한 JSON', () => {
  assert.deepEqual(parseLooseJson('{"a":1}'), { a: 1 });
});

test('느슨한 파싱: 코드펜스로 감싼 경우', () => {
  assert.deepEqual(parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseLooseJson('```\n{"a":1}\n```'), { a: 1 });
});

test('느슨한 파싱: 닫는 펜스를 빠뜨려도 살린다', () => {
  assert.deepEqual(parseLooseJson('```json\n{"a":1}'), { a: 1 });
});

test('느슨한 파싱: 앞뒤 잡담을 걷어낸다', () => {
  assert.deepEqual(parseLooseJson('아래와 같습니다.\n{"a":1}\n이상입니다.'), { a: 1 });
});

test('느슨한 파싱: 문자열 안 날것 줄바꿈을 escape해 복구', () => {
  const raw = '{"translation":"첫 문단\n\n둘째 문단\t끝","summary":"요약"}';
  assert.deepEqual(parseLooseJson(raw), { translation: '첫 문단\n\n둘째 문단\t끝', summary: '요약' });
});

test('느슨한 파싱: 이미 escape된 \n은 건드리지 않는다', () => {
  assert.deepEqual(parseLooseJson('{"t":"a\nb"}'), { t: 'a\nb' });
});

test('느슨한 파싱: 구조가 깨진 건 그대로 throw(호출부가 원문 폴백)', () => {
  assert.throws(() => parseLooseJson('{"a":'));
  assert.throws(() => parseLooseJson('완전히 딴소리'));
});

test('파싱 실패 메시지는 꼬리도 남긴다(깨진 곳은 대개 뒤쪽)', withKey(async () => {
  const long = 'x'.repeat(900);
  const bad = { stop_reason: 'end_turn', content: [{ type: 'text', text: `{"t":"${long}` }] };
  await assert.rejects(
    () => askLlmJSON({ system: 's', user: 'u', fetchImpl: resOf(bad) }),
    /생략/,
  );
}));

// ── 스키마 강제 출력 ──────────────────────────────────────────
// 회귀: 긴 한국어 본문 속 따옴표를 이스케이프하지 않은 응답이 섞여 161건 중 28건이 파싱 실패

test('objectSchema: 전 필드 required, additionalProperties false, string?는 null 허용', () => {
  const s = objectSchema({ a: 'string', b: 'string?', c: 'boolean' });
  assert.deepEqual(s.required, ['a', 'b', 'c']);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.a, { type: 'string' });
  assert.deepEqual(s.properties.b, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  assert.deepEqual(s.properties.c, { type: 'boolean' });
});

test('anthropic: schema를 주면 output_config.format(json_schema)으로 보낸다', withKey(async () => {
  const { impl, calls } = captureFetch(shape.anthropic);
  const schema = objectSchema({ title_ko: 'string', summary_ko: 'string?' });
  await askLlmJSON({ system: 'SYS', user: 'USR', schema, fetchImpl: impl });
  assert.deepEqual(calls[0].body.output_config, { format: { type: 'json_schema', schema } });
}));

test('anthropic: schema가 없으면 output_config를 보내지 않는다', withKey(async () => {
  const { impl, calls } = captureFetch(shape.anthropic);
  await askLlmJSON({ system: 'SYS', user: 'USR', fetchImpl: impl });
  assert.equal('output_config' in calls[0].body, false);
}));

test('openai: schema는 무시하고 기존 json 모드 그대로', withEnv({ OPENAI_API_KEY: 'k' }, async () => {
  const { impl, calls } = captureFetch(shape.openai);
  await askLlmJSON({ system: 'SYS', user: 'USR', schema: objectSchema({ a: 'string' }), fetchImpl: impl });
  assert.equal('output_config' in calls[0].body, false);
  assert.equal(calls[0].body.response_format.type, 'json_object');
}));
