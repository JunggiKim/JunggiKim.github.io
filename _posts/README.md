# 📝 블로그 글 작성 가이드

이 폴더는 Jekyll 블로그의 게시글을 저장하는 곳입니다.

## 🚀 빠른 시작

### 1. 새 글 만들기

GitHub 웹사이트에서:
1. 이 폴더(`_posts`)에서 "Add file" → "Create new file" 클릭
2. 파일명 입력: `YYYY-MM-DD-제목.md`
3. 아래 템플릿 사용해서 글 작성
4. "Commit changes" 클릭

### 2. 파일명 규칙

```
YYYY-MM-DD-title-in-english.md
```

**예시:**
- ✅ `2025-11-22-hello-world.md`
- ✅ `2025-12-01-my-first-post.md`
- ❌ `hello-world.md` (날짜 없음)
- ❌ `2025.11.22-post.md` (점 사용)

**규칙:**
- 날짜는 하이픈(`-`)으로 구분
- 제목은 영문 소문자 + 하이픈
- 공백 대신 하이픈 사용
- 확장자는 `.md`

---

## 📄 글 작성 템플릿

```markdown
---
title: "여기에 글 제목 입력"
date: 2025-11-22 14:30:00 +0900
categories: [카테고리]
tags: [태그1, 태그2, 태그3]
toc: true
toc_sticky: true
---

# 메인 제목

여기에 본문 내용을 작성합니다.

## 소제목

내용 작성...

### 작은 소제목

- 목록 항목 1
- 목록 항목 2

**굵은 글씨**
*기울임 글씨*

> 인용문

![이미지 설명](/assets/images/파일명.jpg)
```

---

## 🎨 Front Matter 필드 설명

```yaml
---
title: "글 제목"                      # 필수: 따옴표로 감싸기
date: 2025-11-22 15:00:00 +0900      # 필수: 한국 시간대 +0900
categories: [개발, 일상]              # 대분류 (배열 형식)
tags: [Jekyll, 블로그, 가이드]        # 소분류 태그들
toc: true                            # 목차 표시 (true/false)
toc_sticky: true                     # 목차 고정 (true/false)
toc_label: "목차"                    # 목차 제목 (선택)
published: true                      # 공개 여부 (false면 비공개)
---
```

### Front Matter 예시

```yaml
---
title: "Jekyll 블로그 시작하기"
date: 2025-11-22 15:00:00 +0900
categories: [개발]
tags: [Jekyll, GitHub Pages, 블로그]
toc: true
toc_sticky: true
---
```

---

## ✍️ 마크다운 문법 가이드

### 제목

```markdown
# 가장 큰 제목 (H1)
## 큰 제목 (H2)
### 중간 제목 (H3)
#### 작은 제목 (H4)
```

### 텍스트 서식

```markdown
**굵은 글씨**
*기울임*
***굵은 기울임***
~~취소선~~
`인라인 코드`
```

### 목록

```markdown
# 순서 없는 목록
- 항목 1
- 항목 2
  - 하위 항목 2-1
  - 하위 항목 2-2

# 순서 있는 목록
1. 첫 번째
2. 두 번째
3. 세 번째
```

### 링크

```markdown
[링크 텍스트](https://example.com)
[내부 링크]({% post_url 2025-11-22-post-name %})
```

### 이미지

```markdown
![대체 텍스트](/assets/images/image.jpg)
![외부 이미지](https://example.com/image.jpg)
```

### 인용

```markdown
> 이것은 인용문입니다.
> 여러 줄도 가능합니다.
```

### 코드 블록

````markdown
```python
def hello():
    print("Hello, World!")
```
````

### 표

```markdown
| 제목1 | 제목2 | 제목3 |
|------|------|------|
| 내용1 | 내용2 | 내용3 |
| 내용4 | 내용5 | 내용6 |
```

### 구분선

```markdown
---
```

---

## 🖼️ 이미지 추가하기

### 방법 1: 저장소에 이미지 업로드

1. `assets/images` 폴더로 이동
2. "Upload files" 클릭
3. 이미지 파일 업로드
4. "Commit changes" 클릭
5. 글에서 사용:
   ```markdown
   ![이미지 설명](/assets/images/파일명.jpg)
   ```

### 방법 2: 외부 이미지 링크

```markdown
![이미지](https://example.com/image.jpg)
```

---

## 📋 카테고리 & 태그 가이드

### 카테고리 (대분류)

```yaml
categories: [개발]           # 단일 카테고리
categories: [개발, 일상]     # 복수 카테고리
```

**추천 카테고리:**
- 개발
- 일상
- 학습
- 회고
- 프로젝트

### 태그 (소분류)

```yaml
tags: [Python, Django, Backend]
tags: [독서, 리뷰]
tags: [알고리즘, 코딩테스트, Leetcode]
```

---

## 🔍 글 작성 체크리스트

글을 발행하기 전에 확인하세요:

- [ ] 파일명이 `YYYY-MM-DD-title.md` 형식인가요?
- [ ] Front Matter에 `title`이 있나요?
- [ ] Front Matter에 `date`가 있나요?
- [ ] 날짜 형식이 `YYYY-MM-DD HH:MM:SS +0900`인가요?
- [ ] `categories`와 `tags`를 설정했나요?
- [ ] 맞춤법을 확인했나요?
- [ ] 이미지 경로가 올바른가요?
- [ ] 코드 블록의 언어를 지정했나요?

---

## 📝 실전 예시

### 파일명
```
2025-11-22-django-tutorial.md
```

### 내용

```markdown
---
title: "Django로 간단한 블로그 만들기"
date: 2025-11-22 20:00:00 +0900
categories: [개발]
tags: [Python, Django, Backend, 튜토리얼]
toc: true
toc_sticky: true
---

# Django 블로그 프로젝트

Django를 사용해서 간단한 블로그를 만들어봅시다.

## 환경 설정

먼저 가상환경을 만듭니다.

```bash
python -m venv venv
source venv/bin/activate
pip install django
```

## 프로젝트 생성

```bash
django-admin startproject myblog
cd myblog
python manage.py startapp blog
```

## 모델 정의

```python
from django.db import models

class Post(models.Model):
    title = models.CharField(max_length=200)
    content = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.title
```

## 마이그레이션

```bash
python manage.py makemigrations
python manage.py migrate
```

## 마무리

Django의 기본적인 구조를 이해할 수 있었습니다.

> 다음 포스트에서는 뷰와 템플릿을 다뤄보겠습니다.
```

---

## 🛠️ 문제 해결

### Q: 글이 블로그에 안 보여요
- 파일명이 `YYYY-MM-DD-title.md` 형식인지 확인
- Front Matter가 `---`로 시작하고 끝나는지 확인
- `published: false`로 설정되어 있지 않은지 확인
- 날짜가 미래가 아닌지 확인

### Q: 이미지가 안 보여요
- 이미지 경로가 `/assets/images/파일명.jpg` 형식인지 확인
- 파일명의 대소문자를 정확히 입력했는지 확인
- 이미지 파일이 실제로 업로드되었는지 확인

### Q: 목차가 안 보여요
- `toc: true` 설정 확인
- `#`, `##`, `###` 제목이 본문에 있는지 확인

### Q: 날짜 형식이 헷갈려요
- 한국 시간: `2025-11-22 15:00:00 +0900`
- 시간은 24시간 형식 (오후 3시 = 15:00)
- `+0900`은 한국 시간대 (변경하지 마세요)

---

## 💡 팁

### 1. 초안 작성
먼저 `published: false`로 작성하고, 완성 후 `true`로 변경

### 2. 날짜 관리
- 파일명의 날짜: 글의 URL에 사용
- Front Matter의 date: 실제 발행 시간

### 3. 목차 활용
긴 글은 `toc: true`로 목차를 표시해서 가독성 향상

### 4. 태그 일관성
비슷한 주제의 글은 동일한 태그를 사용해서 분류

### 5. 이미지 최적화
큰 이미지는 압축해서 업로드 (페이지 로딩 속도 향상)

---

## 🤖 AI 에이전트 도움받기

`에이전트.md` 파일을 참고하면 AI 에이전트가 자동으로 글을 작성하는 방법을 알 수 있습니다.

---

## 📚 더 알아보기

- [Jekyll 공식 문서](https://jekyllrb.com/docs/)
- [Minimal Mistakes 테마 문서](https://mmistakes.github.io/minimal-mistakes/)
- [마크다운 가이드](https://www.markdownguide.org/)

---

**Happy Blogging! 😊**
