---
title: "LIKE 검색만으로 버틸 수 있을까: MySQL 인덱스 추가와 검색 API 로직 전환 기록"
date: 2026-02-18 14:30:00 +0900
categories: [tech]
tags: [mysql, index, fulltext, search, spring-boot, query-optimization, feature-flag]
toc: true
toc_sticky: true
---

> 검색 성능은 SQL 한 줄이 아니라 "인덱스 설계 + API 분기 + 롤아웃 전략"을 함께 바꿔야 안정적으로 개선됐다.

---

## 문제 상황

기존 검색 경로는 `LIKE '%keyword%'` 비중이 높았다.
데이터가 커질수록 인덱스 활용이 어려워지고, 조인/그룹핑 쿼리 비용도 함께 증가했다.

운영에서 필요한 목표는 두 가지였다.

1. 검색 지연을 줄인다.
2. 기능 회귀 없이 단계적으로 전환한다.

---

## 분석 포인트

| 관점 | 확인한 이슈 |
|------|-------------|
| 문자열 검색 | 선행 와일드카드로 인덱스 활용 제한 |
| 태그/카테고리 | 서브쿼리 + 조인 비용 증가 |
| 인기 검색어 | 기간 필터 + `GROUP BY` 비용 증가 |
| 롤아웃 | 한 번에 전환 시 회귀 리스크 큼 |

결론은 "인덱스만 추가"로는 부족하고, API 경로 분기까지 같이 설계해야 한다는 것이었다.

---

## 해결 전략

### 1단계: 공통 조회 인덱스 보강

먼저 인증/주문/장바구니/리뷰 등 자주 쓰는 조회 패턴의 복합 인덱스를 추가했다.
목표는 검색 이전에 전체 DB 부하 바닥을 낮추는 것이었다.

### 2단계: 검색 전용 인덱스 도입

검색 경로에는 FULLTEXT(ngram) + 복합 인덱스를 함께 적용했다.

```sql
ALTER TABLE product ADD FULLTEXT INDEX ft_product_name (product_name) WITH PARSER ngram;
ALTER TABLE product_tag ADD INDEX idx_tag_deleted_product (tag_id, deleted_at, product_id);
ALTER TABLE search_history ADD INDEX idx_created_deleted_keyword (created_at, deleted_at, keyword);
```

여기서 포인트는 "FULLTEXT만"이 아니다.
태그 매핑, 검색 이력 집계처럼 주변 쿼리까지 같이 최적화해야 체감이 나온다.

### 3단계: Feature Flag 기반 경로 분리

검색 API는 FF를 기준으로 분기했다.

- `OFF`: 기존 LIKE 경로 + 기존 저장 흐름
- `ON`: FULLTEXT 경로 + 비동기 검색 이력 이벤트

추가로 2자 미만 키워드는 기존 경로로 fallback해서 과도한 분할 토큰 문제를 줄였다.

---

## 동작 방식 (요약)

```text
[요청 유입]
  -> FF OFF ? 기존 QueryDSL LIKE 경로
           : FULLTEXT + native query 경로
  -> 검색 결과 반환
  -> (ON일 때) 검색 이력 비동기 이벤트 발행
```

실제 로직에서 `MATCH ... AGAINST`와 `REPLACE(..., ' ', '') LIKE`를 조합해 한글/공백 케이스를 함께 처리했다.

---

## 검증 방식

이번 전환은 "빠르다"보다 "기능 동일성" 검증을 먼저 뒀다.

| 검증 항목 | 내용 |
|-----------|------|
| OFF/ON 결과 동일성 | 동일 키워드에서 결과 집합 비교 |
| 제외 조건 | 삭제/비노출 데이터 제외 검증 |
| 엣지 케이스 | 1글자/짧은 키워드 fallback 검증 |
| 혼재 케이스 | 활성+삭제 데이터 섞인 상태 검증 |

통합 테스트는 검색/자동완성/필터 경로를 각각 검증해 회귀 위험을 줄였다.

---

## 트레이드오프

| 선택 | 장점 | 단점 |
|------|------|------|
| FULLTEXT + 복합 인덱스 | 검색/조건 필터 성능 개선 여지 큼 | 인덱스 관리 비용 증가 |
| FF 기반 점진 전환 | 롤백/비교 검증 용이 | 분기 코드 유지 비용 |
| 비동기 검색 이력 저장 | 요청 경로 지연 완화 | 이벤트 운영 복잡도 증가 |

핵심은 "성능만" 보지 않는 것이다.
검색 품질, 회귀 리스크, 운영 복잡도를 같이 관리해야 전환이 안정적이다.

---

## 처음 읽는 사람을 위한 적용 순서

1. 현재 검색 SQL을 패턴별로 분류한다.
2. WHERE/JOIN/GROUP BY 기준으로 필요한 인덱스를 먼저 설계한다.
3. API 경로를 FF로 분리해 OFF/ON 동시 운영 기간을 둔다.
4. 기능 동일성 테스트를 통과한 뒤 ON 범위를 점진 확대한다.
5. ON 안정화 이후에만 구 경로 제거를 검토한다.

---

## 정리

검색 최적화는 단순히 `LIKE`를 `FULLTEXT`로 바꾸는 작업이 아니었다.
인덱스 설계, API 분기, 테스트, 롤백 전략까지 함께 설계할 때 운영 안정성을 유지한 채 성능 개선을 가져갈 수 있었다.

---

## 참고 자료

- MySQL FULLTEXT Search: https://dev.mysql.com/doc/refman/8.0/en/fulltext-search.html
- MySQL Boolean Full-Text Searches: https://dev.mysql.com/doc/refman/8.0/en/fulltext-boolean.html
- MySQL ngram Parser: https://dev.mysql.com/doc/refman/8.0/en/fulltext-search-ngram.html
- MySQL EXPLAIN: https://dev.mysql.com/doc/refman/8.0/en/explain.html
- Feature Flags (Martin Fowler): https://martinfowler.com/articles/feature-toggles.html
