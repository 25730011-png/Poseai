// ===== PoseAi 중계 서버 (Cloudflare Workers) =====
// 하는 일: 사이트 대신 공공데이터 API와 AI를 불러 주고, 키는 여기에만 숨겨 둠
// 설정할 것 (Cloudflare → Worker → Settings → Variables and Secrets)
//   SERVICE_KEY  : 공공데이터포털 인증키 (Decoding 키)          → Secret
//   GEMINI_KEY   : Google API 키 (AQ. 로 시작)                 → Secret
//   OPENAI_KEY   : OpenAI 키 (sk- 로 시작, Gemini 안 될 때 예비) → Secret (선택)
//   ALLOW_ORIGIN : https://25730011-png.github.io               → Text

const HOSP_URL = 'https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList';
// 사이트에서 고를 수 있는 모델 (app.js의 AI_MODELS와 id가 같아야 함)
const MODELS = {
  'gemini-2.5-flash-lite': 'gemini',
  'gemini-2.5-flash': 'gemini',
  'gemini-2.5-pro': 'gemini',
  'gpt-4o-mini': 'openai',
  'gpt-4.1-mini': 'openai'
};
const DEFAULT_MODEL = 'gemini-2.5-flash';

// AI에게 주는 규칙 (진단처럼 말하지 않게)
const RULES = [
  '너는 PoseAi의 자세 코치야. 한국어 해요체로 2~4문장으로 짧게 답해.',
  '다루는 건 거북목, 어깨 수평, 골반 수평, 앉은 자세, 스트레칭, 생활 습관뿐이야. 다른 주제는 정중히 거절해.',
  '의학적 진단, 병명 추정, 약, 치료법은 말하지 마. 측정값은 참고용이라고 말해.',
  '통증, 저림, 두통이 있거나 오래가면 재활의학과·정형외과 같은 전문가 상담을 권해.',
  '스트레칭은 무리하지 말고 아프면 멈추라고 알려 줘.'
].join('\n');

async function askGemini(key, model, text) {
  const isPro = model.includes('pro');
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: RULES }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    // Pro는 생각을 끌 수 없어서 최소(128)로, 나머지는 생각 끔(0) → 빠르게
    generationConfig: { temperature: 0.6, maxOutputTokens: isPro ? 1200 : 400, thinkingConfig: { thinkingBudget: isPro ? 128 : 0 } }
  });
  const urls = key.startsWith('AQ.')
    ? [`https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${key}`,
       `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`]
    : [`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`];
  let lastErr = '';
  for (const u of urls) {
    const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const data = await res.json();
    if (res.ok) {
      const parts = data.candidates?.[0]?.content?.parts || [];
      const answer = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
      if (answer) return answer;
      lastErr = '빈 답변';
    } else {
      lastErr = data.error?.message || String(res.status);
    }
  }
  throw new Error(`${model}: ${lastErr}`);
}

async function askOpenAI(key, model, text) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, temperature: 0.6, max_tokens: 400,
      messages: [{ role: 'system', content: RULES }, { role: 'user', content: text }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${model}: ` + (data.error?.message || res.status));
  return data.choices[0].message.content.trim();
}

async function callModel(env, model, text) {
  if (MODELS[model] === 'gemini') {
    if (!env.GEMINI_KEY) throw new Error('GEMINI_KEY 없음');
    return askGemini(env.GEMINI_KEY, model, text);
  }
  if (!env.OPENAI_KEY) throw new Error('OPENAI_KEY 없음');
  return askOpenAI(env.OPENAI_KEY, model, text);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
    });
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // 병원 목록: /hospitals?sidoCd=110000&dgsbjtCd=21&page=1
    if (url.pathname === '/hospitals') {
      const params = new URLSearchParams({
        ServiceKey: env.SERVICE_KEY,
        pageNo: url.searchParams.get('page') || '1',
        numOfRows: '10',
        _type: 'json'
      });
      for (const k of ['sidoCd', 'sgguCd', 'dgsbjtCd', 'yadmNm']) {
        const v = url.searchParams.get(k);
        if (v) params.set(k, v);
      }
      try {
        const res = await fetch(`${HOSP_URL}?${params}`);
        return new Response(await res.text(), {
          status: res.status,
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (err) {
        return json({ error: '공공데이터 API 호출 실패' }, 502);
      }
    }

    // AI 자세 코치: POST /ai  { question, context, model }
    if (url.pathname === '/ai' && request.method === 'POST') {
      let q = '', ctx = '', model = DEFAULT_MODEL;
      try {
        const b = await request.json();
        q = String(b.question || '').slice(0, 300);
        ctx = String(b.context || '').slice(0, 400);
        if (MODELS[b.model]) model = b.model;
      } catch (e) { /* 빈 요청 */ }
      if (!q) return json({ error: '질문이 비어 있어요' }, 400);
      const text = `${ctx}\n질문: ${q}`;

      // 고른 모델 먼저 → 안 되면 다른 회사 빠른 모델로 대신 답하기
      const backup = MODELS[model] === 'gemini' ? 'gpt-4o-mini' : 'gemini-2.5-flash-lite';
      const errors = [];
      for (const m of [model, backup]) {
        try { return json({ answer: await callModel(env, m, text), model: m }); }
        catch (e) { errors.push(e.message); }
      }
      return json({ error: errors.join(' / ') }, 502);
    }

    return new Response('PoseAi relay OK', { headers: cors });
  }
};
