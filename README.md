# PoseAi

웹캠으로 보는 나의 체형, 진단부터 교정까지
AI 체형 진단 및 모니터링 서비스

## 소개
설치·가입·별도 장비 없이 노트북 웹캠과 브라우저만으로 거북목·어깨 수평·골반 수평 3가지를 측정하고,
날짜별 기록과 교정 가이드까지 한 흐름으로 제공하는 웹서비스입니다.

- 영상·사진은 저장·전송하지 않고 브라우저 안에서만 처리
- 의학적 진단이 아닌 참고용 분석

## 화면 구성
index.html 하나에 화면을 section으로 나눠 넣고, 주소 끝 #이름으로 전환해요. 기능은 모두 js/app.js에 있어요.

| 주소 | 화면 | 내용 |
|---|---|---|
| #home | 메인 | 서비스 소개, 진행 순서, 측정 항목, 바로가기 |
| #measure | 촬영·측정 | 정면·측면 각 5초 측정 |
| #report | 체형 리포트 | 항목별 값·단계, 종합 점수(100점), 기록 저장 |
| #history | 기록·그래프 | 날짜별 기록, 정렬·필터, 변화 그래프 |
| #guide | 교정 가이드 | 스트레칭, FAQ 챗봇, 병원 찾기 |
| #login, #signup | 로그인·회원가입 (선택) | 기록 동기화용 |

## 사용 기술
- HTML, CSS, JavaScript
- MediaPipe Pose (웹캠 자세 인식)
- LocalStorage (기록 저장), Chart.js (변화 그래프)
- 건강보험심사평가원 병원정보서비스 오픈API (인증키는 Cloudflare Workers 중계 서버에만 보관)
- GitHub Pages 배포

## 폴더 구조
```
poseai/
├── index.html      화면 구조 (메인, 측정, 리포트, 기록, 교정 가이드, 로그인)
├── css/
│   └── style.css   배치와 시각 표현
├── js/
│   └── app.js      측정, 점수 계산, 기록 저장, 그래프, FAQ, 화면 전환
├── data/           JSON 데이터
│   ├── criteria.json   판단 기준표 (양호·주의·확인 권장)
│   ├── guide.json      스트레칭
│   ├── faq.json        FAQ
│   └── hospital-codes.json  병원 찾기 지역·진료과목 코드
└── asset/          카드·상세에 쓸 이미지
```

## 팀원
- 임서연 (25730035) 팀장: 기획, 자료조사, 교정 가이드·FAQ 데이터, 오픈API 연동
- 정유진 (25730011) 팀원: UI/UX 설계, 화면·기능 구현, 통합·배포

## 배포
https://25730011-png.github.io/poseai

## 지금 버전
- 디자인 시안(남색·파랑·하늘색, Poppins·Gothic A1·도현체·Noto Sans KR) 적용 버전
- 로고: asset/logo.svg

## 업데이트 (11/9~11/11)
- 측정 항목: 기획서대로 거북목·어깨 수평·골반 수평 3가지 (정면 5초 + 측면 5초)
- 리포트에 "같이 나타난 자세 패턴" 추가: data/combos.json (주의 이상 항목끼리 묶어서 설명)
- 교정 가이드에 "어디가 불편하세요?" (불편한 부위 체크) 추가: data/body-parts.json
- 교정 가이드에 추천 영상, 동작 그림(asset/stretch) 추가
- guide.json의 key → keys(배열): 스트레칭 하나가 여러 항목에 연결됨

## 로그인 + 기록 저장 (Firebase, 11/10)
- 회원가입: 아이디 + 닉네임 + 비밀번호 / 로그인: 아이디 + 비밀번호
- Firebase Authentication(이메일/비밀번호) 사용. 아이디는 안에서 아이디@poseai.app 으로 처리
- Firestore: users/{uid} (아이디·닉네임), users/{uid}/records/{저장 시각} (측정 기록)
- 보안 규칙: 로그인한 본인만 자기 데이터 읽기·쓰기 (firebase-rules.txt)
- js/app.js 의 firebaseConfig 에 Firebase 웹 앱 설정값을 넣으면 연결됨
- 처음엔 구글 시트(Apps Script)로 만들었다가, 비밀번호가 없고 누구나 조회할 수 있는 보안 문제 때문에 Firebase로 바꿈
