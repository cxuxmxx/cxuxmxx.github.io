---
title: "[Spring] @Transactional 전파 레벨 이해하기"
excerpt: "송금 시스템 예제 코드로 Spring @Transactional 전파 레벨을 차근차근 정리해요."

toc: true
toc_sticky: true

date: 2026-07-02
last_modified_at: 2026-07-02

categories:
  - Spring
tags:
  - Spring
  - Transaction
  - Transactional
  - Propagation
  - JPA
---

안녕하세요. 결제와 정산 도메인을 다루는 백엔드 엔지니어 곽철민이에요.

트랜잭션은 처음 배울 때보다, 실제 서비스를 만들면서 더 어렵게 느껴지는 주제인 것 같아요. 특히 `@Transactional`의 전파 레벨은 이름만 보면 알 것 같다가도, 막상 코드에 붙이려고 하면 손이 멈추는 순간이 있어요.

예를 들어 송금 시스템을 만든다고 해볼게요.

- A 계좌에서 돈을 차감해야 해요.
- B 계좌에 돈을 입금해야 해요.
- 송금 이력을 저장해야 해요.
- 감사 로그도 남겨야 해요.
- 알림도 보내야 해요.

겉으로 보면 하나의 송금 요청이지만, 내부에서는 여러 작업이 이어져요. 여기서 중요한 질문이 생겨요.

> 이 작업들을 전부 하나의 트랜잭션으로 묶어야 할까요?  
> 아니면 일부 작업은 실패해도 따로 커밋되어야 할까요?

이 질문에 답하기 위해 필요한 개념이 바로 **트랜잭션 전파 레벨(Transaction Propagation)** 이에요.

---

## 전파 레벨이란 무엇일까요?

전파 레벨은 이미 실행 중인 트랜잭션이 있을 때, 새로 호출된 메서드가 그 트랜잭션을 어떻게 사용할지 정하는 규칙이에요.

조금 더 쉽게 말하면 이런 질문에 대한 답이에요.

> "지금 트랜잭션이 있는데, 나도 거기에 같이 들어갈까?  
> 아니면 내 트랜잭션을 새로 만들까?  
> 혹은 트랜잭션 없이 실행할까?"

Spring에서는 `@Transactional(propagation = ...)` 형태로 전파 레벨을 지정해요.

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void saveAuditLog(...) {
    ...
}
```

기본값은 `REQUIRED`예요. 그래서 보통 `@Transactional`만 붙이면 아래 코드와 같다고 보면 돼요.

```java
@Transactional(propagation = Propagation.REQUIRED)
public void transfer(...) {
    ...
}
```

---

## 예제 시나리오: 송금 시스템

이번 글에서는 아래 흐름을 기준으로 전파 레벨을 살펴볼게요.

```text
사용자 송금 요청
   |
   v
출금 계좌 조회
   |
   v
입금 계좌 조회
   |
   v
출금 계좌 잔액 차감
   |
   v
입금 계좌 잔액 증가
   |
   v
송금 이력 저장
   |
   v
감사 로그 저장
   |
   v
알림 발송
```

송금 자체는 원자적으로 처리되어야 해요. 출금만 되고 입금이 안 되면 큰일 나죠. 그래서 출금, 입금, 송금 이력 저장은 하나의 트랜잭션으로 묶는 게 자연스러워요.

하지만 감사 로그나 알림은 조금 다르게 볼 수 있어요.

- 감사 로그는 송금이 실패하더라도 남기고 싶을 수 있어요.
- 알림 발송은 실패해도 송금 자체를 롤백시키고 싶지 않을 수 있어요.

이런 판단을 코드로 표현할 때 전파 레벨이 필요해요.

---

## 예제 엔티티

먼저 계좌 엔티티를 간단히 만들어볼게요.

```java
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import java.math.BigDecimal;

@Entity
public class Account {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String accountNumber;

    private BigDecimal balance;

    protected Account() {
    }

    public Account(String accountNumber, BigDecimal balance) {
        this.accountNumber = accountNumber;
        this.balance = balance;
    }

    public void withdraw(BigDecimal amount) {
        if (balance.compareTo(amount) < 0) {
            throw new IllegalArgumentException("잔액이 부족해요.");
        }

        this.balance = this.balance.subtract(amount);
    }

    public void deposit(BigDecimal amount) {
        this.balance = this.balance.add(amount);
    }

    public Long getId() {
        return id;
    }

    public String getAccountNumber() {
        return accountNumber;
    }

    public BigDecimal getBalance() {
        return balance;
    }
}
```

송금 이력 엔티티도 만들어볼게요.

```java
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Entity
public class TransferHistory {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String fromAccountNumber;
    private String toAccountNumber;
    private BigDecimal amount;
    private LocalDateTime transferredAt;

    protected TransferHistory() {
    }

    public TransferHistory(String fromAccountNumber, String toAccountNumber, BigDecimal amount) {
        this.fromAccountNumber = fromAccountNumber;
        this.toAccountNumber = toAccountNumber;
        this.amount = amount;
        this.transferredAt = LocalDateTime.now();
    }
}
```

감사 로그 엔티티도 별도로 둘게요.

```java
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import java.time.LocalDateTime;

@Entity
public class AuditLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String eventType;
    private String message;
    private LocalDateTime createdAt;

    protected AuditLog() {
    }

    public AuditLog(String eventType, String message) {
        this.eventType = eventType;
        this.message = message;
        this.createdAt = LocalDateTime.now();
    }
}
```

Repository는 간단하게 이렇게 둘 수 있어요.

```java
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AccountRepository extends JpaRepository<Account, Long> {
    Optional<Account> findByAccountNumber(String accountNumber);
}
```

```java
import org.springframework.data.jpa.repository.JpaRepository;

public interface TransferHistoryRepository extends JpaRepository<TransferHistory, Long> {
}
```

```java
import org.springframework.data.jpa.repository.JpaRepository;

public interface AuditLogRepository extends JpaRepository<AuditLog, Long> {
}
```

---

## REQUIRED: 기존 트랜잭션에 참여하고, 없으면 새로 만들어요

`REQUIRED`는 가장 많이 쓰는 전파 레벨이에요. 기본값이기도 해요.

현재 트랜잭션이 있으면 거기에 참여하고, 없으면 새 트랜잭션을 만들어요.

```java
@Transactional
public void transfer(String fromAccountNumber, String toAccountNumber, BigDecimal amount) {
    Account fromAccount = accountRepository.findByAccountNumber(fromAccountNumber)
            .orElseThrow(() -> new IllegalArgumentException("출금 계좌가 없어요."));

    Account toAccount = accountRepository.findByAccountNumber(toAccountNumber)
            .orElseThrow(() -> new IllegalArgumentException("입금 계좌가 없어요."));

    fromAccount.withdraw(amount);
    toAccount.deposit(amount);

    transferHistoryRepository.save(
            new TransferHistory(fromAccountNumber, toAccountNumber, amount)
    );
}
```

이 코드에서 출금, 입금, 송금 이력 저장은 하나의 트랜잭션으로 묶여요.

중간에 예외가 발생하면 전부 롤백돼요.

```text
출금 성공
입금 성공
송금 이력 저장 실패
   |
   v
출금 롤백
입금 롤백
송금 이력 저장 롤백
```

송금 같은 핵심 비즈니스 로직은 대부분 `REQUIRED`로 묶는 게 자연스러워요. 하나라도 실패하면 전체가 실패해야 하기 때문이에요.

---

## REQUIRED에서 주의할 점: 내부 호출은 프록시를 타지 않아요

Spring의 `@Transactional`은 기본적으로 프록시 기반으로 동작해요. 그래서 같은 클래스 안에서 자기 자신의 메서드를 호출하면 트랜잭션 설정이 적용되지 않아요.

아래 코드는 기대한 대로 동작하지 않을 수 있어요.

```java
@Service
public class TransferService {

    @Transactional
    public void transfer(...) {
        ...
        saveAuditLog(...);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void saveAuditLog(...) {
        ...
    }
}
```

`transfer()`가 같은 클래스의 `saveAuditLog()`를 직접 호출하면 Spring 프록시를 거치지 않아요. 그래서 `REQUIRES_NEW`가 적용되지 않을 수 있어요.

이럴 때는 서비스를 분리하는 편이 좋아요.

```java
@Service
public class TransferService {

    private final AuditLogService auditLogService;

    public TransferService(AuditLogService auditLogService) {
        this.auditLogService = auditLogService;
    }

    @Transactional
    public void transfer(...) {
        ...
        auditLogService.saveAuditLog(...);
    }
}
```

실무에서 전파 레벨이 “왜 안 먹지?” 싶을 때, 이 내부 호출 문제가 꽤 자주 나와요.

---

## REQUIRES_NEW: 무조건 새 트랜잭션을 만들어요

`REQUIRES_NEW`는 기존 트랜잭션이 있어도 잠시 멈춰두고, 새로운 트랜잭션을 만들어 실행해요.

송금 시스템에서는 감사 로그 저장에 자주 어울려요.

예를 들어 송금 처리 중에 실패가 발생하더라도, “송금 시도가 있었다”는 로그는 남기고 싶을 수 있어요.

```java
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuditLogService {

    private final AuditLogRepository auditLogRepository;

    public AuditLogService(AuditLogRepository auditLogRepository) {
        this.auditLogRepository = auditLogRepository;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void saveAuditLog(String eventType, String message) {
        auditLogRepository.save(new AuditLog(eventType, message));
    }
}
```

송금 서비스에서는 이렇게 호출할 수 있어요.

```java
import java.math.BigDecimal;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TransferService {

    private final AccountRepository accountRepository;
    private final TransferHistoryRepository transferHistoryRepository;
    private final AuditLogService auditLogService;

    public TransferService(
            AccountRepository accountRepository,
            TransferHistoryRepository transferHistoryRepository,
            AuditLogService auditLogService
    ) {
        this.accountRepository = accountRepository;
        this.transferHistoryRepository = transferHistoryRepository;
        this.auditLogService = auditLogService;
    }

    @Transactional
    public void transfer(String fromAccountNumber, String toAccountNumber, BigDecimal amount) {
        auditLogService.saveAuditLog(
                "TRANSFER_REQUESTED",
                fromAccountNumber + " -> " + toAccountNumber + " 송금을 시작했어요."
        );

        Account fromAccount = accountRepository.findByAccountNumber(fromAccountNumber)
                .orElseThrow(() -> new IllegalArgumentException("출금 계좌가 없어요."));

        Account toAccount = accountRepository.findByAccountNumber(toAccountNumber)
                .orElseThrow(() -> new IllegalArgumentException("입금 계좌가 없어요."));

        fromAccount.withdraw(amount);
        toAccount.deposit(amount);

        transferHistoryRepository.save(
                new TransferHistory(fromAccountNumber, toAccountNumber, amount)
        );

        auditLogService.saveAuditLog(
                "TRANSFER_SUCCEEDED",
                fromAccountNumber + " -> " + toAccountNumber + " 송금이 완료됐어요."
        );
    }
}
```

흐름을 그림처럼 보면 이래요.

```text
transfer() 트랜잭션 시작
   |
   |-- saveAuditLog() 새 트랜잭션 시작
   |       |
   |       |-- 감사 로그 저장
   |       |
   |       v
   |   saveAuditLog() 커밋
   |
   |-- 출금
   |-- 입금
   |-- 송금 이력 저장
   |
   v
transfer() 커밋
```

만약 송금 도중에 실패해서 `transfer()`가 롤백되어도, `REQUIRES_NEW`로 저장된 감사 로그는 이미 별도 트랜잭션으로 커밋됐기 때문에 남아 있어요.

```text
감사 로그 저장 커밋
송금 처리 중 예외 발생
송금 트랜잭션 롤백

결과:
- 계좌 잔액 변경 롤백
- 송금 이력 롤백
- 감사 로그는 유지
```

이게 `REQUIRES_NEW`의 가장 큰 특징이에요. 독립적으로 커밋되어야 하는 작업에 사용해요.

다만 남용하면 안 돼요. 트랜잭션을 새로 만든다는 건 그만큼 커넥션도 추가로 필요하고, 흐름도 복잡해진다는 뜻이에요.

---

## NESTED: 중첩 트랜잭션을 만들고, 부분 롤백할 수 있어요

`NESTED`는 기존 트랜잭션 안에 저장 지점(savepoint)을 만들어요.

전체 트랜잭션은 유지하되, 특정 작업만 저장 지점으로 되돌릴 수 있어요.

송금 시스템에서는 “부가 정보 저장은 실패해도 송금은 계속 진행하고 싶다”는 경우를 생각해볼 수 있어요.

예를 들어 송금 메모를 따로 저장한다고 해볼게요.

```java
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TransferMemoService {

    private final TransferMemoRepository transferMemoRepository;

    public TransferMemoService(TransferMemoRepository transferMemoRepository) {
        this.transferMemoRepository = transferMemoRepository;
    }

    @Transactional(propagation = Propagation.NESTED)
    public void saveMemo(Long transferId, String memo) {
        transferMemoRepository.save(new TransferMemo(transferId, memo));
    }
}
```

호출하는 쪽에서는 예외를 잡아서 전체 송금을 계속 진행할 수 있어요.

```java
@Transactional
public void transferWithMemo(
        String fromAccountNumber,
        String toAccountNumber,
        BigDecimal amount,
        String memo
) {
    Account fromAccount = accountRepository.findByAccountNumber(fromAccountNumber)
            .orElseThrow(() -> new IllegalArgumentException("출금 계좌가 없어요."));

    Account toAccount = accountRepository.findByAccountNumber(toAccountNumber)
            .orElseThrow(() -> new IllegalArgumentException("입금 계좌가 없어요."));

    fromAccount.withdraw(amount);
    toAccount.deposit(amount);

    TransferHistory history = transferHistoryRepository.save(
            new TransferHistory(fromAccountNumber, toAccountNumber, amount)
    );

    try {
        transferMemoService.saveMemo(history.getId(), memo);
    } catch (RuntimeException e) {
        auditLogService.saveAuditLog(
                "TRANSFER_MEMO_FAILED",
                "송금은 성공했지만 메모 저장은 실패했어요. transferId=" + history.getId()
        );
    }
}
```

흐름은 이런 느낌이에요.

```text
부모 트랜잭션 시작
   |
   |-- 출금
   |-- 입금
   |-- 송금 이력 저장
   |
   |-- NESTED savepoint 생성
   |      |
   |      |-- 메모 저장 실패
   |      |
   |      v
   |   savepoint까지만 롤백
   |
   v
부모 트랜잭션 커밋
```

`REQUIRES_NEW`와 헷갈릴 수 있는데, 둘은 달라요.

| 전파 레벨 | 핵심 차이 |
|---|---|
| `REQUIRES_NEW` | 완전히 새로운 트랜잭션을 만들어요. 부모가 롤백돼도 자식 커밋은 유지될 수 있어요. |
| `NESTED` | 부모 트랜잭션 안에서 savepoint를 만들어요. 부모가 최종 롤백되면 같이 롤백돼요. |

즉 `NESTED`는 독립 커밋이 아니라 **부분 롤백**에 가까워요.

그리고 중요한 점이 있어요. `NESTED`는 사용하는 트랜잭션 매니저와 데이터베이스가 savepoint를 지원해야 제대로 동작해요. JPA 환경에서는 기대와 다르게 동작할 수 있으니, 실제 프로젝트에서는 반드시 테스트로 확인하는 게 좋아요.

---

## SUPPORTS: 트랜잭션이 있으면 참여하고, 없으면 없이 실행해요

`SUPPORTS`는 적극적으로 트랜잭션을 만들지는 않아요.

이미 트랜잭션이 있으면 참여하고, 없으면 트랜잭션 없이 실행해요.

송금 시스템에서는 단순 조회성 메서드에 사용할 수 있어요.

```java
import java.math.BigDecimal;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountQueryService {

    private final AccountRepository accountRepository;

    public AccountQueryService(AccountRepository accountRepository) {
        this.accountRepository = accountRepository;
    }

    @Transactional(readOnly = true, propagation = Propagation.SUPPORTS)
    public BigDecimal getBalance(String accountNumber) {
        Account account = accountRepository.findByAccountNumber(accountNumber)
                .orElseThrow(() -> new IllegalArgumentException("계좌가 없어요."));

        return account.getBalance();
    }
}
```

이 메서드는 단독으로 호출되면 트랜잭션 없이 실행돼요.

하지만 이미 트랜잭션 안에서 호출되면 그 트랜잭션에 참여해요.

```text
트랜잭션 밖에서 호출:
getBalance() -> 트랜잭션 없이 실행

트랜잭션 안에서 호출:
transfer() 트랜잭션
   |
   v
getBalance() -> transfer() 트랜잭션에 참여
```

단순 조회에서는 괜찮지만, lazy loading이나 영속성 컨텍스트 동작을 기대하는 코드라면 조심해야 해요.

---

## NOT_SUPPORTED: 트랜잭션을 잠시 멈추고, 트랜잭션 없이 실행해요

`NOT_SUPPORTED`는 현재 트랜잭션이 있어도 그 트랜잭션을 잠시 중단하고, 트랜잭션 없이 실행해요.

송금 시스템에서는 외부 API 호출 같은 작업을 예로 들 수 있어요.

```java
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class NotificationService {

    private final NotificationClient notificationClient;

    public NotificationService(NotificationClient notificationClient) {
        this.notificationClient = notificationClient;
    }

    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public void sendTransferNotification(String accountNumber, String message) {
        notificationClient.send(accountNumber, message);
    }
}
```

외부 API 호출은 DB 트랜잭션과 성격이 달라요.

트랜잭션 안에서 외부 API를 오래 기다리면 DB 커넥션을 오래 붙잡게 돼요. 서비스 트래픽이 많아지면 커넥션 풀이 부족해질 수도 있어요.

그래서 “이 작업은 DB 트랜잭션과 분리해서 실행하겠다”는 의도로 `NOT_SUPPORTED`를 사용할 수 있어요.

```text
transfer() 트랜잭션 시작
   |
   |-- 출금
   |-- 입금
   |
   |-- sendTransferNotification()
   |      |
   |      |-- 기존 트랜잭션 잠시 중단
   |      |-- 트랜잭션 없이 외부 알림 API 호출
   |
   v
transfer() 트랜잭션 재개 후 커밋
```

다만 알림 발송을 정말 이 시점에 동기로 처리해야 하는지도 고민해봐야 해요. 실무에서는 트랜잭션 커밋 이후 이벤트를 발행하거나, 메시지 큐를 사용하는 방식이 더 안정적일 때가 많아요.

---

## MANDATORY: 반드시 기존 트랜잭션이 있어야 해요

`MANDATORY`는 이미 트랜잭션이 존재해야만 실행돼요.

트랜잭션 없이 호출되면 예외가 발생해요.

이 전파 레벨은 “이 메서드는 단독으로 호출되면 안 된다”는 의도를 코드에 박아두고 싶을 때 사용할 수 있어요.

예를 들어 계좌 잔액 변경은 반드시 송금 트랜잭션 안에서만 일어나야 한다고 해볼게요.

```java
import java.math.BigDecimal;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountCommandService {

    private final AccountRepository accountRepository;

    public AccountCommandService(AccountRepository accountRepository) {
        this.accountRepository = accountRepository;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void withdraw(String accountNumber, BigDecimal amount) {
        Account account = accountRepository.findByAccountNumber(accountNumber)
                .orElseThrow(() -> new IllegalArgumentException("출금 계좌가 없어요."));

        account.withdraw(amount);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void deposit(String accountNumber, BigDecimal amount) {
        Account account = accountRepository.findByAccountNumber(accountNumber)
                .orElseThrow(() -> new IllegalArgumentException("입금 계좌가 없어요."));

        account.deposit(amount);
    }
}
```

그리고 송금 서비스에서는 이렇게 호출해요.

```java
@Transactional
public void transfer(String fromAccountNumber, String toAccountNumber, BigDecimal amount) {
    accountCommandService.withdraw(fromAccountNumber, amount);
    accountCommandService.deposit(toAccountNumber, amount);

    transferHistoryRepository.save(
            new TransferHistory(fromAccountNumber, toAccountNumber, amount)
    );
}
```

이렇게 하면 `withdraw()`와 `deposit()`은 반드시 바깥의 `transfer()` 트랜잭션 안에서 실행돼요.

누군가 실수로 아래처럼 단독 호출하면 예외가 발생해요.

```java
accountCommandService.withdraw("A-001", BigDecimal.valueOf(10_000));
```

`MANDATORY`는 방어적인 설계에 가까워요. 팀 코드에서 “이 메서드는 반드시 상위 트랜잭션이 필요해요”라는 의도를 명확히 드러낼 수 있어요.

---

## NEVER: 트랜잭션이 있으면 예외를 발생시켜요

`NEVER`는 `MANDATORY`와 반대예요.

트랜잭션이 있으면 실행하지 않고 예외를 발생시켜요.

송금 시스템에서 외부 정산 리포트를 생성하거나, 아주 긴 파일 작업을 한다고 해볼게요. 이런 작업은 DB 트랜잭션 안에서 실행되면 위험할 수 있어요.

```java
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SettlementReportService {

    @Transactional(propagation = Propagation.NEVER)
    public void createDailySettlementReport() {
        // 긴 파일 생성, 외부 스토리지 업로드, 대량 데이터 가공 등을 수행한다고 가정해요.
    }
}
```

이 메서드를 트랜잭션 안에서 호출하면 예외가 발생해요.

```java
@Transactional
public void transfer(...) {
    ...
    settlementReportService.createDailySettlementReport(); // 예외 발생
}
```

`NEVER`는 자주 쓰는 전파 레벨은 아니에요. 하지만 “이 작업은 절대 트랜잭션 안에서 돌면 안 돼요”라는 정책을 강하게 표현할 때 쓸 수 있어요.

---

## 전파 레벨 한눈에 정리하기

| 전파 레벨 | 기존 트랜잭션이 있으면 | 기존 트랜잭션이 없으면 | 송금 시스템 예시 |
|---|---|---|---|
| `REQUIRED` | 기존 트랜잭션에 참여해요. | 새 트랜잭션을 만들어요. | 송금 핵심 로직 |
| `REQUIRES_NEW` | 기존 트랜잭션을 멈추고 새 트랜잭션을 만들어요. | 새 트랜잭션을 만들어요. | 감사 로그 저장 |
| `NESTED` | savepoint를 만들고 중첩 실행해요. | 새 트랜잭션을 만들어요. | 부가 정보 부분 롤백 |
| `SUPPORTS` | 기존 트랜잭션에 참여해요. | 트랜잭션 없이 실행해요. | 단순 잔액 조회 |
| `NOT_SUPPORTED` | 기존 트랜잭션을 멈추고 트랜잭션 없이 실행해요. | 트랜잭션 없이 실행해요. | 외부 알림 API 호출 |
| `MANDATORY` | 기존 트랜잭션에 참여해요. | 예외가 발생해요. | 반드시 송금 트랜잭션 안에서만 수행할 잔액 변경 |
| `NEVER` | 예외가 발생해요. | 트랜잭션 없이 실행해요. | 트랜잭션 안에서 돌면 안 되는 긴 작업 |

---

## 예외와 롤백 기준도 같이 알아야 해요

전파 레벨을 이해할 때 예외 처리도 같이 봐야 해요.

Spring의 기본 롤백 정책은 이래요.

- `RuntimeException` 또는 `Error`가 발생하면 롤백돼요.
- 체크 예외(`Exception`)는 기본적으로 롤백되지 않아요.

예를 들어 아래 코드는 런타임 예외라 롤백돼요.

```java
@Transactional
public void transfer(...) {
    ...
    throw new IllegalStateException("송금 처리 중 문제가 발생했어요.");
}
```

하지만 체크 예외까지 롤백하고 싶다면 `rollbackFor`를 명시해야 해요.

```java
@Transactional(rollbackFor = Exception.class)
public void transfer(...) throws Exception {
    ...
    throw new Exception("외부 시스템 오류가 발생했어요.");
}
```

그리고 `REQUIRES_NEW` 같은 별도 트랜잭션을 사용할 때는 예외를 어디서 잡는지도 중요해요.

```java
@Transactional
public void transfer(...) {
    try {
        auditLogService.saveAuditLog("TRANSFER_REQUESTED", "송금을 시작했어요.");
    } catch (RuntimeException e) {
        // 감사 로그 실패 때문에 송금 자체를 중단할지,
        // 아니면 로그만 포기하고 계속 진행할지 정책을 정해야 해요.
    }

    ...
}
```

예외를 잡지 않고 밖으로 던지면 바깥 트랜잭션까지 영향을 받을 수 있어요. 그래서 “이 실패가 전체 실패인지, 부분 실패인지”를 먼저 정해야 해요.

---

## 실무에서 자주 만나는 실수들

### 1. 알림 실패 때문에 송금까지 롤백되는 경우가 있어요

송금 후 알림을 보내는 코드를 같은 트랜잭션 안에 넣으면, 알림 발송 실패가 송금 롤백으로 이어질 수 있어요.

```java
@Transactional
public void transfer(...) {
    ...
    notificationService.sendTransferNotification(...);
}
```

알림은 보통 DB 트랜잭션의 일부로 보기 어려워요. 알림 실패 때문에 실제 송금까지 취소할지, 아니면 송금은 성공시키고 알림만 재시도할지 정책을 분리하는 게 좋아요.

실무에서는 보통 이런 방식도 많이 사용해요.

- 커밋 이후 이벤트 발행
- 메시지 큐 사용
- 실패 알림 재시도 테이블 적재
- 배치 기반 재처리

---

### 2. `REQUIRES_NEW`를 붙였는데 동작하지 않는 경우가 있어요

앞에서 봤던 내부 호출 문제예요.

```java
this.saveAuditLog(...);
```

이런 식으로 같은 클래스 내부에서 호출하면 프록시를 타지 않아요. 그래서 전파 레벨이 적용되지 않을 수 있어요.

전파 레벨을 확실히 적용하려면 별도 Spring Bean으로 분리해서 호출하는 편이 좋아요.

---

### 3. `NESTED`를 믿고 썼는데 savepoint가 안 잡힐 수 있어요

`NESTED`는 savepoint 기반이에요. 그래서 트랜잭션 매니저와 데이터베이스 지원 여부가 중요해요.

JPA 환경에서는 `DataSourceTransactionManager`를 쓰는 JDBC 기반 코드와 다르게 동작할 수 있어요. 팀에서 `NESTED`를 사용한다면 반드시 통합 테스트로 실제 롤백 범위를 확인해야 해요.

---

### 4. 외부 API 호출을 트랜잭션 안에서 오래 붙잡는 경우가 있어요

트랜잭션 안에서 외부 API를 호출하면 DB 커넥션을 잡은 채로 네트워크 응답을 기다리게 돼요.

```java
@Transactional
public void transfer(...) {
    ...
    externalPaymentClient.approve(...); // 오래 걸릴 수 있어요.
}
```

트래픽이 적을 때는 잘 모르지만, 요청이 몰리면 커넥션 풀이 빠르게 고갈될 수 있어요.

외부 연동은 트랜잭션 경계를 잘게 나누거나, 이벤트 기반으로 분리하는 방식도 함께 고민하는 게 좋아요.

---

## 테스트 코드로 전파 레벨을 확인해보기

전파 레벨은 눈으로만 보면 감이 잘 안 와요. 그래서 테스트로 확인하는 게 좋아요.

예를 들어 감사 로그는 송금이 실패해도 남아야 한다고 해볼게요.

```java
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class TransferServiceTest {

    @Autowired
    TransferService transferService;

    @Autowired
    AccountRepository accountRepository;

    @Autowired
    AuditLogRepository auditLogRepository;

    @Test
    void 송금이_실패해도_REQUIRES_NEW로_저장한_감사로그는_남는다() {
        accountRepository.save(new Account("A-001", BigDecimal.valueOf(1_000)));
        accountRepository.save(new Account("B-001", BigDecimal.ZERO));

        assertThatThrownBy(() ->
                transferService.transfer("A-001", "B-001", BigDecimal.valueOf(10_000))
        ).isInstanceOf(IllegalArgumentException.class);

        assertThat(auditLogRepository.findAll())
                .extracting("eventType")
                .contains("TRANSFER_REQUESTED");
    }
}
```

이 테스트가 통과한다면 `TRANSFER_REQUESTED` 로그는 별도 트랜잭션으로 커밋됐다는 뜻이에요.

반대로 `REQUIRED`로 저장했다면 바깥 송금 트랜잭션이 롤백될 때 감사 로그도 함께 롤백될 가능성이 높아요.

---

## 저는 이렇게 기준을 잡아요

전파 레벨을 고를 때는 먼저 기술 이름을 떠올리기보다, 작업의 성격을 먼저 나누는 편이 좋아요.

| 질문 | 어울리는 선택 |
|---|---|
| 이 작업은 전체 비즈니스 성공/실패와 반드시 같이 가야 하나요? | `REQUIRED` |
| 이 작업은 실패하더라도 기록이 남아야 하나요? | `REQUIRES_NEW` |
| 이 작업만 부분 롤백하고 전체는 계속 진행하고 싶나요? | `NESTED` |
| 조회인데 트랜잭션이 있으면 참여만 하면 되나요? | `SUPPORTS` |
| DB 트랜잭션과 분리해서 실행해야 하나요? | `NOT_SUPPORTED` |
| 반드시 상위 트랜잭션 안에서만 실행돼야 하나요? | `MANDATORY` |
| 트랜잭션 안에서 실행되면 위험한 작업인가요? | `NEVER` |

결국 중요한 건 “이 메서드가 어떤 트랜잭션 경계를 가져야 하는가”예요.

전파 레벨은 외워서 쓰는 옵션이라기보다, 비즈니스 정책을 코드에 표현하는 도구에 가까워요.

---

## 정리

`@Transactional` 전파 레벨은 처음 보면 옵션이 많아서 부담스럽게 느껴져요. 그런데 송금 시스템처럼 하나의 흐름에 여러 작업이 섞여 있는 예제를 놓고 보면 조금 선명해져요.

- 송금 핵심 로직은 함께 성공하거나 함께 실패해야 하므로 `REQUIRED`가 어울려요.
- 감사 로그처럼 독립적으로 남겨야 하는 기록은 `REQUIRES_NEW`가 어울릴 수 있어요.
- 일부 부가 작업만 되돌리고 싶다면 `NESTED`를 검토할 수 있어요.
- 단순 조회나 외부 호출은 트랜잭션 경계를 더 신중히 나눠야 해요.
- `MANDATORY`, `NEVER`는 메서드 호출 정책을 강하게 표현할 때 사용할 수 있어요.

트랜잭션은 단순히 DB 작업을 묶는 기술이 아니라, 서비스의 실패 기준을 정하는 설계에 가까워요.

그래서 전파 레벨을 고를 때는 이렇게 물어보면 좋아요.

> 이 작업은 누구와 함께 커밋되어야 할까요?  
> 그리고 누구와 함께 롤백되어야 할까요?

이 질문에 답할 수 있으면 `@Transactional` 전파 레벨도 훨씬 덜 무섭게 느껴질 거예요.
