---
title: "LIKE 검색만으로 버틸 수 있을까: MySQL 인덱스 추가와 검색 API 로직 전환 기록"
date: 2026-02-18 14:30:00 +0900
categories: [tech]
tags: [mysql, index, fulltext, search, spring-boot, query-optimization, feature-flag]
toc: true
toc_sticky: true
---

> 검색 성능 개선은 인덱스 하나로 끝나지 않았고, "DB 구조 + API 로직 + 롤아웃 전략"을 함께 바꾸는 작업이었습니다.

---

## 문제 상황

기존 검색 경로는 `LIKE '%keyword%'` 패턴 비중이 높아서 데이터가 커질수록 부담이 커졌습니다.
또한 검색 관련 서브쿼리와 집계 쿼리도 함께 늘어나면서, 단순 로직 개선만으로는 한계가 보였습니다.

저희는 검색 성능 문제를 코드 레벨에서만 보지 않고,
**인덱스 설계와 API 로직을 같이 바꾸는 방식**
으로 접근하기로 했습니다.

---

## 증상과 분석

분석 단계에서 저희가 확인한 포인트는 세 가지였습니다.

1. 선행 와일드카드(`%keyword%`)는 인덱스 활용이 제한적입니다.
2. 태그/검색이력 관련 쿼리는 조인·그룹핑 성능 영향이 큽니다.
3. 검색 로직 전환은 기능 리스크가 커서 단계적 롤아웃이 필요합니다.

따라서 "한 번의 대규모 변경"보다, 인덱스와 로직을 분리해 점진 전환하는 계획이 현실적이었습니다.

---

## 원인 파악

핵심 원인은 DB와 애플리케이션의 최적화 방향이 따로 움직였던 점이었습니다.
DB에는 검색 패턴에 맞는 인덱스 설계가 부족했고, 애플리케이션은 기존 LIKE 경로에 의존하고 있었습니다.

즉,
**검색 성능 병목의 원인은 SQL 한 줄이 아니라 경로 전체 설계**
였습니다.

---

## 해결 방법

### 1) 1차: 범용 쿼리 최적화 인덱스 추가

먼저 공통 조회 경로에서 반복적으로 사용되는 조건을 기준으로 인덱스를 보강했습니다.
인증/주문/장바구니/리뷰/노출 상태 등 핵심 도메인 조회 패턴을 커버하는 복합 인덱스 마이그레이션을 추가했습니다.

### 2) 2차: 검색 전용 인덱스와 로직 전환

검색 전용 단계에서는 FULLTEXT + 복합 인덱스를 함께 도입했습니다.
`product`, `brand`, `tag`, `category`에 ngram 파서 기반 FULLTEXT 인덱스를 추가하고, `product_tag`, `search_history`에 커버링/복합 인덱스를 적용했습니다.

```sql
ALTER TABLE product ADD FULLTEXT INDEX ft_product_name (product_name) WITH PARSER ngram;
ALTER TABLE product_tag ADD INDEX idx_tag_deleted_product (tag_id, deleted_at, product_id);
ALTER TABLE search_history ADD INDEX idx_created_deleted_keyword (created_at, deleted_at, keyword);
```

### 3) Feature Flag 기반 점진 적용

검색 경로 전환은 리스크가 커서 Feature Flag를 넣었습니다.
FF `OFF`에서는 기존 경로를 유지하고, `ON`에서 FULLTEXT 경로를 사용하도록 분리해 단계적으로 검증했습니다.

---

## 트레이드오프

FULLTEXT 도입은 조회 성능 개선 여지가 크지만, 인덱스 크기와 운영 복잡도가 늘어납니다.
또한 API 로직과 인덱스 전략을 동시에 바꾸면 효과는 크지만 회귀 위험도 함께 커집니다.

그래서 저희는 아래 전략을 택했습니다.

| 선택 | 장점 | 단점 |
|------|------|------|
| FULLTEXT + 복합 인덱스 | 검색 경로 최적화, 조건 필터링 개선 | 인덱스 관리 비용 증가 |
| FF 기반 점진 전환 | 롤백/비교 검증 용이 | 분기 코드 관리 필요 |
| 테스트 보강(통합/단위) | 회귀 방지 | 초기 작성 비용 증가 |

---

## 근거

- 커밋 `ce7c66984` (`feat(db): Add query optimized indexes migration`)
- 커밋 `8de5426ec` (`feat(search): FULLTEXT INDEX 기반 검색 최적화 + 비동기 이벤트`)
- 파일 `support/db-migration/src/main/resources/db/migration-common/V2026_01_10_000000__add_query_optimized_indexes.sql`
- 파일 `support/db-migration/src/main/resources/db/migration-common/V2026_01_30_100000__search__add_fulltext_indexes.sql`
- 파일 `support/db-migration/src/main/resources/db/migration-common/V2026_01_30_100100__search__add_composite_indexes.sql`
- 파일 `apis/app/src/main/kotlin/com/deartail/app/search/SearchRepository.kt`
- 파일 `apis/app/src/main/kotlin/com/deartail/app/search/SearchQueryService.kt`

---

## 정리

- 검색 성능 개선은 인덱스 추가만으로 끝나지 않았고 API 경로 전환 전략까지 함께 필요했습니다.
- FULLTEXT 도입은 효과가 크지만, 롤아웃 안전장치(FF)와 테스트 보강이 반드시 따라와야 했습니다.
- DB 최적화와 애플리케이션 로직을 같이 설계할 때 실제 운영 안정성이 올라갔습니다.

여러분은 검색 최적화 시 FULLTEXT 전환을 한 번에 적용하시나요, 아니면 단계적으로 분리 적용하시나요?
