# asset

사이트에서 쓰는 그림 파일

```
asset/
├ logo.svg              로고 (SVG, 그대로 asset 바로 아래)
└ images/               사진·그림(jpg, png)은 전부 여기
   ├ coach-robot.jpg    FAQ · AI 코치 떠 있는 버튼 "포즈봇"
   ├ hero-skeleton.png  홈 히어로 배경 자세 골격선 (선만 남기고 투명하게 바꿈)
   ├ measure/           홈 "이 3가지를 측정해요" 그림
   │  ├ neck.jpg        거북목
   │  ├ shoulder.jpg    어깨 수평
   │  └ pelvis.jpg      골반 수평
   └ stretch/           교정 가이드 스트레칭 동작 그림
      ├ chin-tuck.jpg   턱 당기기
      ├ chest-open.jpg  가슴 펴기
      ├ side-neck.jpg   옆목 늘리기 (화살표 위치만 직접 수정)
      ├ scapula.jpg     날개뼈 모으기
      ├ side-bend.jpg   옆구리 늘리기
      ├ glute.jpg       엉덩이 근육 늘리기
      └ hip-flexor.jpg  골반 앞쪽 늘리기
```

- logo.svg를 뺀 그림은 모두 AI 생성 이미지 (ChatGPT, 2026.11)
- 새 그림을 넣을 땐 images/ 안에 넣고, 경로를 data/guide.json 이나 index.html 에 맞춰 바꾸기
