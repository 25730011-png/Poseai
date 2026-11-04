// ===== PoseAi 중계 서버 (Cloudflare Workers) =====
// 하는 일: 사이트 대신 공공데이터 API와 AI를 불러 주고, 키는 여기에만 숨겨 둠
// 설정할 것 (Cloudflare → Worker → Settings → Variables and Secrets)
//   SERVICE_KEY  : 공공데이터포털 인증키 (Decoding 키)          → Secret
//   GEMINI_KEY   : Google API 키 (AQ. 로 시작)                 → Secret
//   OPENAI_KEY   : OpenAI 키 (sk- 로 시작, Gemini 안 될 때 예비) → Secret (선택)
//   ALLOW_ORIGIN : https://25730011-png.github.io               → Text

const HOSP_URL = 'https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList';
const GEMINI_MODEL = 'gemini-2.5-flash';

// AI에게 주는 규칙 (진단처럼 말하지 않게)
const RULES = [
  '너는 PoseAi의 자세 코치야. 한국어 해요체로 3~5문장 안으로 짧게 답해.',
  '다루는 건 거북목, 어깨 수평, 골반 수평, 앉은 자세, 스트레칭, 생활 습관뿐이야. 다른 주제는 정중히 거절해.',
  '의학적 진단, 병명 추정, 약, 치료법은 말하지 마. 측정값은 참고용이라고 말해.',
  '통증, 저림, 두통이 있거나 오래가면 재활의학과·정형외과 같은 전문가 상담을 권해.',
  '스트레칭은 무리하지 말고 아프면 멈추라고 알려 줘.'
].join('\n');

async function askGemini(key, text) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: RULES }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } }
  });
  const urls = key.startsWith('AQ.')
    ? [`https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_MODEL}:generateContent?key=${key}`,
       `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`]
    : [`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`];
  let lastErr = '';
  for (const u of urls) {
    const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const data = await res.json();
    if (res.ok) {
      const parts = data.candidates?.[0]?.content?.parts || [];
      return parts.map(p => p.text || '').join('').trim();
    }
    lastErr = data.error?.message || String(res.status);
  }
  throw new Error('Gemini: ' + lastErr);
}

async function askOpenAI(key, text) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini', temperature: 0.6, max_tokens: 800,
      messages: [{ role: 'system', content: RULES }, { role: 'user', content: text }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('OpenAI: ' + (data.error?.message || res.status));
  return data.choices[0].message.content.trim();
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

    // AI 자세 코치: POST /ai  { question, context }
    if (url.pathname === '/ai' && request.method === 'POST') {
      let q = '', ctx = '';
      try {
        const b = await request.json();
        q = String(b.question || '').slice(0, 300);
        ctx = String(b.context || '').slice(0, 400);
      } catch (e) { /* 빈 요청 */ }
      if (!q) return json({ error: '질문이 비어 있어요' }, 400);
      const text = `${ctx}\n질문: ${q}`;
      const errors = [];
      if (env.GEMINI_KEY) {
        try { return json({ answer: await askGemini(env.GEMINI_KEY, text), model: 'gemini' }); }
        catch (e) { errors.push(e.message); }
      }
      if (env.OPENAI_KEY) {
        try { return json({ answer: await askOpenAI(env.OPENAI_KEY, text), model: 'openai' }); }
        catch (e) { errors.push(e.message); }
      }
      return json({ error: errors.join(' / ') || '키가 설정되지 않았어요' }, 502);
    }

    return new Response('PoseAi relay OK', { headers: cors });
  }
};
