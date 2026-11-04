// ===== ⑤ 교정 가이드 (#guide) =====
// 지금 된 것: FAQ 챗봇 (data/faq.json → 질문 버튼 → 답변 말풍선)
// 할 일
// 1. data/guide.json 불러와서 '주의' 이상 항목 스트레칭 카드 표시
// 2. AI 자세 코치 (Gemini, 중계 서버 거쳐서 호출) - 선택
// 3. 오픈API(건강보험심사평가원 병원정보서비스)로 지역별 병원 조회

(function () {
  const chatBox = document.getElementById('chat-box');
  const faqButtons = document.getElementById('faq-buttons');
  const aiForm = document.getElementById('ai-form');

  function addBubble(text, who) {
    const p = document.createElement('p');
    p.className = 'bubble ' + who;
    p.textContent = text;
    chatBox.appendChild(p);
  }

  fetch('data/faq.json')
    .then(res => res.json())
    .then(list => {
      list.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.q;
        btn.addEventListener('click', () => {
          addBubble(item.q, 'user');
          addBubble(item.a, 'bot');
        });
        faqButtons.appendChild(btn);
      });
    })
    .catch(() => {
      faqButtons.textContent = 'FAQ를 불러오지 못했어요. (Live Server나 배포 주소로 열었는지 확인)';
    });

  // AI 자세 코치는 아직 연결 전
  aiForm.addEventListener('submit', e => {
    e.preventDefault();
    const input = document.getElementById('ai-q');
    if (!input.value.trim()) return;
    addBubble(input.value, 'user');
    addBubble('AI 자세 코치는 준비 중이에요. 지금은 위의 질문 버튼을 눌러 보세요.', 'bot');
    input.value = '';
  });
})();
