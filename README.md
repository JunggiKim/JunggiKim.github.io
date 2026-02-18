# JunggiKim.github.io

개발과 일상을 기록하는 블로그입니다.

## Features

- Jekyll + Minimal Mistakes 테마
- Minimal Black & White & Silver 커스텀 스타일
- 다크모드 지원 (시스템 연동 + 수동 토글)
- Giscus 댓글 (대댓글 지원)
- 자동 목차 (TOC)
- 전체 글 검색
- SEO 최적화

## 블로그 URL

https://junggikim.github.io

## 글 작성 방법

`_posts/` 디렉토리에 마크다운 파일 생성:

```markdown
---
title: "포스트 제목"
date: 2024-01-01 10:00:00 +0900
categories: [tech]
tags: [spring, kotlin]
toc: true
toc_sticky: true
---

본문 내용...
```

## 게시된 글

| 날짜 | 제목 | 카테고리 |
|------|------|----------|
| 2026-02-14 | [코드 한 줄 안 바꿨는데 Docker Push가 183MB에서 21MB로 줄었다](https://junggikim.github.io/tech/spring-boot-docker-appcds-layered-jar/) | tech |
| 2026-02-14 | [Spring Boot 배포 후 첫 요청이 느린 이유 — JVM Warmup 로그 기반 분석](https://junggikim.github.io/tech/spring-boot-jvm-warmup-cold-start/) | tech |

## 로컬 실행 (선택)

```bash
bundle install
bundle exec jekyll serve
```

## License

MIT
