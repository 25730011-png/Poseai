// ===== PoseAi 중계 서버 (Cloudflare Workers) =====
// 하는 일: 사이트 대신 공공데이터 API를 불러 주고, 인증키는 여기에만 숨겨 둠
// 설정할 것 (Cloudflare 대시보드 → Worker → Settings → Variables and Secrets)
//   SERVICE_KEY  : 공공데이터포털 인증키 (Decoding 키) → 종류를 Secret으로
//   ALLOW_ORIGIN : https://25730011-png.github.io  (내 사이트에서만 쓸 수 있게)
//   GEMINI_KEY   : 학교에서 받은 Gemini API 키 → 종류를 Secret으로 (AI 자세 코치용, 선택)

// 병원정보서비스 요청 주소: 공공데이터포털 마이페이지 → 활용신청 상세의 End Point와 같은지 확인
const HOSP_URL = 'https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
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
        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: '공공데이터 API 호출 실패' }), {
          status: 502,
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    }

    // AI 자세 코치: POST /ai (사이트에서 보낸 요청 내용을 그대로 Gemini에 전달)
    if (url.pathname === '/ai' && request.method === 'POST') {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
        body: await request.text()
      });
      return new Response(await res.text(), {
        status: res.status,
        headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    return new Response('PoseAi relay', { headers: cors });
  }
};
