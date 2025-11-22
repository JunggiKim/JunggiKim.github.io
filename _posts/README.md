# 블로그 글 작성 가이드

## 파일명 형식

**날짜 없이 제목만 작성 가능** (권장):
```
제목.md
```

예시:
- ✅ `python-guide.md`
- ✅ `django-tutorial.md`
- ✅ `my-first-post.md`
- ⚠️ `2025-11-22-hello-world.md` (구형식, 사용 가능하지만 비권장)

**중요**: 파일명에 날짜가 없어도 Front Matter의 `date` 필드는 필수입니다!

## 작성 워크플로우

### 1단계: 자유롭게 글 작성
파일을 만들고 생각나는 대로 작성:

```markdown
파이썬 기초 가이드

파이썬은 배우기 쉬운 언어입니다.

설치 방법
pip install python

예제 코드
def hello():
    print("Hello")
```

### 2단계: AI에게 포맷팅 요청
```
이 파일을 _posts/README.md 가이드에 맞춰서 포맷팅해줘:
- Front Matter 추가
- 제목 계층 정리 (# ## ###)
- 코드 블록에 언어 지정
- 날짜는 오늘로
- 본문 내용은 그대로 유지
```

### 3단계: AI가 자동 정리
AI가 마크다운 형식을 자동으로 정리해줍니다.

### 4단계: Git Push
```bash
git add _posts/
git commit -m "Add: 새 글 작성"
git push
```

## 글 템플릿 (완성본)

```markdown
---
title: "글 제목"
date: 2025-11-22 15:00:00 +0900
categories: [카테고리]
tags: [태그1, 태그2]
---

# 제목

내용을 작성합니다.

## 소제목

- 목록
- 항목

**굵게** *기울임*

> 인용문

![이미지](/assets/images/파일명.jpg)
```

## 자주 쓰는 마크다운

```markdown
# 제목1
## 제목2
### 제목3

**굵게**
*기울임*
~~취소선~~

- 목록
- 항목

1. 번호
2. 목록

[링크](https://example.com)
![이미지](/assets/images/image.jpg)

> 인용문

​```python
코드 블록
​```
```
