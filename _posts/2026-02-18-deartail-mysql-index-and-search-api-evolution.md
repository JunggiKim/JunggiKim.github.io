---
title: "검색 인덱스 적용하기: MySQL FULLTEXT + 복합 인덱스로 LIKE 중심 검색을 바꾼 과정"
date: 2026-02-18 14:30:00 +0900
categories: [tech]
tags: [mysql, index, fulltext, search, spring-boot, query-optimization]
toc: true
toc_sticky: true
---

> 검색 성능은 SQL 한 줄 교체로 끝나지 않았다. 인덱스 구조, 쿼리 조건, 롤아웃 순서를 함께 바꿔야 효과가 안정적으로 나왔다.

---

## 문제를 다시 정의했다

기존 검색 경로의 중심은 `LIKE '%keyword%'`였다.
데이터가 작을 때는 큰 문제가 없었지만, 데이터가 커질수록 선행 와일드카드가 인덱스 활용을 막았다.

검색은 단일 쿼리로 끝나지 않는다.
상품명 검색뿐 아니라 태그, 브랜드, 카테고리, 인기 키워드 집계가 함께 움직인다.
따라서 한 쿼리만 고쳐서는 체감 개선이 제한적이었다.

핵심 목표는 두 가지였다.

1. 검색 지연을 줄일 것
2. 기능 회귀 없이 점진 전환할 것

---

## 왜 `LIKE '%...%'`가 병목이 되었나

`LIKE '%keyword%'`는 문자열 앞부분이 고정되지 않는다.
그래서 B-Tree 인덱스로 시작 위치를 바로 찾기 어렵고, 스캔 범위가 커진다.

여기에 아래 패턴이 겹치면 비용이 더 커진다.

- 태그 매핑 서브쿼리 (`product_tag`)
- 브랜드/카테고리 조인
- 기간 필터 + `GROUP BY keyword` 집계

즉, 병목은 "상품명 검색" 하나가 아니라 검색 주변 경로 전체에서 발생했다.

---

## 설계 원칙

아래 원칙으로 인덱스를 설계했다.

1. 검색 진입점은 FULLTEXT로 바꾼다.
2. 주변 서브쿼리/집계 쿼리는 복합 인덱스로 받쳐준다.
3. 짧은 키워드/공백 케이스는 fallback을 남겨 정확도를 보완한다.
4. 전환은 한 번에 바꾸지 않고 ON/OFF 분기로 안전하게 진행한다.

---

## 1단계: FULLTEXT 인덱스 적용

먼저 검색 대상 테이블에 ngram FULLTEXT 인덱스를 추가했다.

```sql
ALTER TABLE product  ADD FULLTEXT INDEX ft_product_name (product_name) WITH PARSER ngram;
ALTER TABLE brand    ADD FULLTEXT INDEX ft_brand_name (brand_name) WITH PARSER ngram;
ALTER TABLE tag      ADD FULLTEXT INDEX ft_tag_name (tag_name) WITH PARSER ngram;
ALTER TABLE category ADD FULLTEXT INDEX ft_category_name (category_name) WITH PARSER ngram;
```

### 왜 ngram을 썼나

한국어 검색에서는 토큰 경계가 영어처럼 명확하지 않다.
ngram parser를 쓰면 짧은 단위로 분해된 토큰 기반 검색이 가능해져,
일반 parser 대비 한국어 부분 검색 대응이 안정적이다.

---

## 2단계: 주변 경로 복합 인덱스 적용

FULLTEXT만 넣으면 핵심 검색은 빨라져도 주변 서브쿼리/집계가 남는다.
그래서 함께 사용되는 조건 기준으로 복합 인덱스를 추가했다.

```sql
ALTER TABLE product_tag   ADD INDEX idx_tag_deleted_product (tag_id, deleted_at, product_id);
ALTER TABLE tag           ADD INDEX idx_deleted_at (deleted_at);
ALTER TABLE search_history ADD INDEX idx_created_deleted_keyword (created_at, deleted_at, keyword);
```

### 설계 포인트

- `product_tag`: `tag_id + deleted_at` 필터 후 `product_id`를 바로 반환하도록 커버링 형태 구성
- `search_history`: 기간 필터 + 삭제 필터 + `GROUP BY keyword` 경로에 맞춰 정렬

이 단계가 빠지면 FULLTEXT 도입 후에도 전체 검색 응답 개선 폭이 제한된다.

---

## 3단계: 쿼리 동작 방식 재구성

실제 검색 경로는 `MATCH ... AGAINST`만으로 끝내지 않았다.
공백/짧은 키워드 케이스 정확도를 위해 보완 조건을 함께 뒀다.

### 핵심 조건

```sql
MATCH(p.product_name) AGAINST(? IN BOOLEAN MODE)
AND REPLACE(p.product_name, ' ', '') LIKE CONCAT('%', ?, '%')
```

### 왜 두 조건을 같이 썼나

- `MATCH AGAINST`: 인덱스를 활용한 빠른 후보 탐색
- `REPLACE ... LIKE`: 공백 차이/표기 변형 보완

속도와 정확도 사이에서 한쪽만 고르면 부작용이 커진다.
이번 구성은 후보 집합은 FULLTEXT로 줄이고, 최종 필터 정확도는 LIKE 보완으로 유지하는 전략이다.

---

## 4단계: 짧은 키워드 fallback

2자 미만 키워드는 FULLTEXT 경로만으로 처리하지 않았다.
짧은 입력은 토큰 분해 특성상 오탐/누락이 생기기 쉬워 fallback이 필요했다.

```kotlin
if (!searchName.isNullOrBlank() && searchName.length < 2) {
    return searchProductsWithDetails(...) // 기존 경로
}
```

이 분기를 남겨 두면 전환 초기 품질 리스크를 크게 줄일 수 있다.

---

## 5단계: 점진 롤아웃(ON/OFF)

검색 경로는 feature flag 기준으로 분리해 운영했다.

- OFF: 기존 검색 경로
- ON: FULLTEXT + 복합 인덱스 경로

점진 전환의 장점은 단순하다.
같은 트래픽 조건에서 결과/지연을 비교할 수 있고, 문제 시 즉시 되돌릴 수 있다.

---

## 검증 방식

이번 전환은 "빠르다"보다 "기능 동일성"을 먼저 검증했다.

| 검증 항목 | 내용 |
|-----------|------|
| OFF/ON 결과 동일성 | 동일 키워드 결과 집합 비교 |
| 제외 조건 검증 | 삭제/비노출 데이터 제외 여부 |
| 엣지 케이스 | 1글자, 공백 포함 키워드 |
| 혼재 케이스 | 활성+삭제 데이터 섞인 상태 |
| 자동완성 경로 | 브랜드/상품 혼합 결과 검증 |

성능 수치는 동일 기능이 보장된 뒤에 해석해야 의미가 있다.

---

## 동작 메커니즘 전체 흐름

```text
[요청 유입]
  -> 키워드 길이 확인
  -> (2자 미만) 기존 경로 fallback
  -> (2자 이상) FULLTEXT + LIKE 보완 조건 실행
  -> 태그/브랜드/카테고리 서브쿼리 결합
  -> 복합 인덱스 경로로 후보 집합 축소
  -> 결과 반환
```

핵심은 인덱스와 쿼리가 같이 설계되어야 한다는 점이다.
인덱스만 바꾸거나 SQL만 바꾸면 절반짜리 개선으로 끝난다.

---

## 트레이드오프

| 선택 | 장점 | 단점 |
|------|------|------|
| FULLTEXT + ngram | 한국어 검색 성능/유연성 개선 | 인덱스 저장 비용 증가 |
| 복합 인덱스 추가 | 서브쿼리/집계 경로 안정화 | 마이그레이션 및 유지 관리 포인트 증가 |
| fallback 유지 | 검색 품질 방어 | 경로 분기 코드 복잡도 증가 |
| 점진 롤아웃 | 회귀 리스크 통제 용이 | 비교 운영 기간 동안 코드 이중화 |

검색 최적화는 항상 비용이 따른다.
중요한 건 어떤 비용을 지불하고 어떤 리스크를 줄일지 명시적으로 고르는 일이다.

---

## 실무에서 바로 적용할 순서

1. 현재 검색 SQL을 패턴별로 분류한다.
2. `WHERE/JOIN/GROUP BY` 기준으로 필요한 인덱스를 먼저 설계한다.
3. FULLTEXT 도입 시 ngram/parser 전략을 언어 특성에 맞춰 결정한다.
4. 짧은 키워드/공백 케이스 fallback을 남긴다.
5. ON/OFF 분기로 결과 동일성 검증 후 점진 전환한다.
6. 안정화가 끝난 뒤 불필요한 구경로를 정리한다.

---

## 실패하기 쉬운 지점

1. FULLTEXT만 추가하고 주변 인덱스를 생략한다.
2. 성능 개선만 보고 검색 정확도 회귀를 놓친다.
3. 짧은 키워드 fallback 없이 일괄 전환한다.
4. EXPLAIN 없이 체감으로만 튜닝한다.

---

## 정리

검색 성능 개선의 본질은 `LIKE`를 `MATCH`로 치환하는 작업이 아니었다.
인덱스 구조, 쿼리 조건, fallback, 롤아웃 전략을 하나의 설계로 묶어야 안정적으로 개선된다.

이번 적용에서 효과를 만든 핵심은 세 가지였다.

1. FULLTEXT로 후보 집합 축소
2. 복합 인덱스로 주변 경로 병목 제거
3. 점진 전환으로 기능 회귀 리스크 통제

---

## 참고 자료

- MySQL FULLTEXT Search: https://dev.mysql.com/doc/refman/8.0/en/fulltext-search.html
- MySQL Boolean Full-Text Searches: https://dev.mysql.com/doc/refman/8.0/en/fulltext-boolean.html
- MySQL ngram Parser: https://dev.mysql.com/doc/refman/8.0/en/fulltext-search-ngram.html
- MySQL Optimizer and Indexes: https://dev.mysql.com/doc/refman/8.0/en/mysql-indexes.html
- MySQL EXPLAIN: https://dev.mysql.com/doc/refman/8.0/en/explain.html
