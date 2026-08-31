---
title: "[Spring] TransactionTemplate으로 트랜잭션 직접 제어하기"
excerpt: "Spring Boot와 Java 예제 코드로 TransactionTemplate이 왜 필요하고, 언제 @Transactional보다 유용한지 정리해요."

toc: true
toc_sticky: true

date: 2026-08-31
last_modified_at: 2026-08-31

categories:
  - Spring
tags:
  - Spring
  - Spring Boot
  - Transaction
  - TransactionTemplate
  - JPA
---

안녕하세요. 오늘은 Spring의 `TransactionTemplate`에 대해 정리해보려고 해요.

Spring에서 트랜잭션을 다룰 때 가장 많이 쓰는 방식은 `@Transactional`이에요. 서비스 메서드 위에 어노테이션 하나만 붙이면 트랜잭션 시작, 커밋, 롤백을 Spring이 알아서 처리해주죠.

그런데 실무 코드를 보다 보면 이런 순간이 생겨요.

> "이 부분까지만 먼저 커밋하고, 그 다음에 외부 API를 호출하고 싶은데?"  
> "하나의 메서드 안에서 트랜잭션 범위를 더 짧게 나누고 싶은데?"  
> "조건에 따라 수동으로 롤백 여부를 제어하고 싶은데?"

이럴 때 `@Transactional`만으로는 표현이 애매해지는 경우가 있어요. 그때 사용할 수 있는 도구가 바로 **TransactionTemplate**이에요.

---

## TransactionTemplate이란?

`TransactionTemplate`은 Spring이 제공하는 **프로그래밍 방식의 트랜잭션 처리 도구**예요.

`@Transactional`이 선언형 트랜잭션이라면, `TransactionTemplate`은 코드 안에서 직접 트랜잭션 범위를 지정하는 방식이에요.

```java
transactionTemplate.execute(status -> {
    // 이 블록 안에서 실행되는 코드는 하나의 트랜잭션으로 묶여요.
    return result;
});
```

반환값이 필요 없으면 `executeWithoutResult()`를 사용할 수도 있어요.

```java
transactionTemplate.executeWithoutResult(status -> {
    // 트랜잭션 안에서 실행할 코드
});
```

구조만 보면 try-catch-finally를 직접 짜는 것처럼 보일 수 있지만, 실제 커밋과 롤백 처리는 Spring의 `PlatformTransactionManager`가 처리해요.

즉 개발자는 트랜잭션 범위만 명확하게 코드로 표현하면 돼요.

---

## @Transactional과 무엇이 다를까요?

먼저 가장 큰 차이는 **트랜잭션 경계를 어디에 표현하느냐**예요.

| 구분 | `@Transactional` | `TransactionTemplate` |
|---|---|---|
| 방식 | 선언형 | 프로그래밍 방식 |
| 트랜잭션 경계 | 메서드 단위 | 코드 블록 단위 |
| 가독성 | 일반적인 서비스 로직에 좋음 | 트랜잭션 범위를 세밀하게 보여주기 좋음 |
| self-invocation 영향 | 있음 | 없음 |
| 동적 제어 | 제한적 | 비교적 자유로움 |

대부분의 일반적인 서비스 로직은 `@Transactional`이 더 좋아요. 코드도 짧고, Spring스럽고, 의도도 잘 드러나요.

하지만 한 메서드 안에서 트랜잭션 범위를 정확히 나눠야 한다면 `TransactionTemplate`이 더 솔직한 코드가 될 수 있어요.

---

## 예제 시나리오: 송금 요청 처리

예제로 송금 시스템을 생각해볼게요.

송금 요청은 보통 이런 흐름을 가져요.

```text
1. 송금 요청 생성
2. 고객 계좌 출금
3. 외부 송금사 API 호출
4. 외부 송금 결과 반영
5. 실패 시 보상 처리
```

여기서 조심해야 할 부분이 있어요.

DB 트랜잭션은 롤백할 수 있지만, 외부 API 호출은 DB처럼 롤백할 수 없어요.

그래서 아래처럼 하나의 큰 트랜잭션 안에서 외부 API까지 호출하는 구조는 위험할 수 있어요.

```java
@Transactional
public void remit(Long commandId) {
    withdraw(commandId);

    externalRemitClient.request(commandId); // 외부 API 호출

    complete(commandId);
}
```

외부 송금 요청은 성공했는데, 그 뒤 DB 저장에서 예외가 나면 어떻게 될까요?

우리 DB는 롤백됐는데 외부 송금사에는 요청이 나간 상태가 될 수 있어요. 이런 불일치는 운영에서 꽤 아프게 돌아와요.

그래서 트랜잭션 경계를 이렇게 나눠보는 게 좋아요.

```text
[트랜잭션 1]
- 송금 요청 상태 저장
- 고객 계좌 출금
- 상태: REQUESTED
- 커밋

[트랜잭션 밖]
- 외부 송금사 API 호출

[트랜잭션 2]
- 외부사 응답 반영
- 성공: COMPLETED
- 실패: FAILED + 보상 입금
- 커밋
```

이런 흐름을 `TransactionTemplate`으로 표현하면 트랜잭션 경계가 코드에서 바로 보여요.

---

## 예제 엔티티

먼저 계좌 엔티티예요.

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

송금 명령 엔티티도 만들어볼게요.

```java
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Entity
public class RemittanceCommand {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String requestId;
    private String fromAccountNumber;
    private String toAccountNumber;
    private BigDecimal amount;

    @Enumerated(EnumType.STRING)
    private RemittanceStatus status;

    private String externalTransactionId;
    private String failureReason;
    private LocalDateTime requestedAt;
    private LocalDateTime completedAt;

    protected RemittanceCommand() {
    }

    private RemittanceCommand(
            String requestId,
            String fromAccountNumber,
            String toAccountNumber,
            BigDecimal amount
    ) {
        this.requestId = requestId;
        this.fromAccountNumber = fromAccountNumber;
        this.toAccountNumber = toAccountNumber;
        this.amount = amount;
        this.status = RemittanceStatus.REQUESTED;
        this.requestedAt = LocalDateTime.now();
    }

    public static RemittanceCommand requested(
            String requestId,
            String fromAccountNumber,
            String toAccountNumber,
            BigDecimal amount
    ) {
        return new RemittanceCommand(requestId, fromAccountNumber, toAccountNumber, amount);
    }

    public void processing() {
        this.status = RemittanceStatus.PROCESSING;
    }

    public void complete(String externalTransactionId) {
        this.status = RemittanceStatus.COMPLETED;
        this.externalTransactionId = externalTransactionId;
        this.completedAt = LocalDateTime.now();
    }

    public void fail(String failureReason) {
        this.status = RemittanceStatus.FAILED;
        this.failureReason = failureReason;
        this.completedAt = LocalDateTime.now();
    }

    public void unknown(String failureReason) {
        this.status = RemittanceStatus.UNKNOWN;
        this.failureReason = failureReason;
    }

    public Long getId() {
        return id;
    }

    public String getRequestId() {
        return requestId;
    }

    public String getFromAccountNumber() {
        return fromAccountNumber;
    }

    public String getToAccountNumber() {
        return toAccountNumber;
    }

    public BigDecimal getAmount() {
        return amount;
    }

    public RemittanceStatus getStatus() {
        return status;
    }
}
```

상태 enum은 이렇게 둘 수 있어요.

```java
public enum RemittanceStatus {
    REQUESTED,
    PROCESSING,
    COMPLETED,
    FAILED,
    UNKNOWN
}
```

`UNKNOWN` 상태를 따로 둔 이유가 있어요. 외부 API 호출에서는 실패보다 더 애매한 상황이 생겨요.

> 요청을 보냈는데, 네트워크 타임아웃 때문에 성공했는지 실패했는지 모르는 상태

이 상태를 `FAILED`로 바로 처리하면 위험해요. 실제 외부사에서는 성공했을 수도 있거든요. 그래서 결과를 모르는 상태는 `UNKNOWN`으로 남기고, 이후 외부사 거래 조회 API나 배치로 보정하는 편이 안전해요.

Repository는 간단하게 준비해둘게요.

```java
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AccountRepository extends JpaRepository<Account, Long> {
    Optional<Account> findByAccountNumber(String accountNumber);
}
```

```java
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface RemittanceCommandRepository extends JpaRepository<RemittanceCommand, Long> {
    Optional<RemittanceCommand> findByRequestId(String requestId);
}
```

---

## TransactionTemplate Bean 설정

Spring Boot에서는 보통 `PlatformTransactionManager`가 자동으로 등록돼요.

JPA를 사용하면 `JpaTransactionManager`가 등록되고, JDBC만 사용하면 `DataSourceTransactionManager`가 등록되는 식이에요.

`TransactionTemplate`은 이 트랜잭션 매니저를 받아서 만들 수 있어요.

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Configuration
public class TransactionConfig {

    @Bean
    public TransactionTemplate transactionTemplate(
            PlatformTransactionManager transactionManager
    ) {
        return new TransactionTemplate(transactionManager);
    }
}
```

필요하면 전파 레벨이나 격리 수준을 기본값으로 지정할 수도 있어요.

```java
import org.springframework.transaction.TransactionDefinition;

@Bean
public TransactionTemplate requiresNewTransactionTemplate(
        PlatformTransactionManager transactionManager
) {
    TransactionTemplate template = new TransactionTemplate(transactionManager);
    template.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    template.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
    template.setTimeout(5);
    return template;
}
```

하지만 처음에는 하나의 기본 `TransactionTemplate`만 두고, 필요한 곳에서 명확히 사용하는 정도로도 충분해요.

---

## execute(): 반환값이 있을 때 사용해요

`execute()`는 트랜잭션 안에서 처리한 결과를 반환해야 할 때 사용해요.

예를 들어 송금 요청을 생성하고, 생성된 command를 반환해야 한다고 해볼게요.

```java
import java.math.BigDecimal;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class RemittanceService {

    private final TransactionTemplate transactionTemplate;
    private final AccountRepository accountRepository;
    private final RemittanceCommandRepository commandRepository;
    private final ExternalRemittanceClient externalRemittanceClient;

    public RemittanceService(
            TransactionTemplate transactionTemplate,
            AccountRepository accountRepository,
            RemittanceCommandRepository commandRepository,
            ExternalRemittanceClient externalRemittanceClient
    ) {
        this.transactionTemplate = transactionTemplate;
        this.accountRepository = accountRepository;
        this.commandRepository = commandRepository;
        this.externalRemittanceClient = externalRemittanceClient;
    }

    public void remit(String fromAccountNumber, String toAccountNumber, BigDecimal amount) {
        RemittanceCommand command = prepare(fromAccountNumber, toAccountNumber, amount);

        ExternalRemittanceResult result = externalRemittanceClient.request(
                command.getRequestId(),
                command.getFromAccountNumber(),
                command.getToAccountNumber(),
                command.getAmount()
        );

        complete(command.getId(), result);
    }

    private RemittanceCommand prepare(
            String fromAccountNumber,
            String toAccountNumber,
            BigDecimal amount
    ) {
        return transactionTemplate.execute(status -> {
            Account account = accountRepository.findByAccountNumber(fromAccountNumber)
                    .orElseThrow(() -> new IllegalArgumentException("출금 계좌가 없어요."));

            account.withdraw(amount);

            RemittanceCommand command = RemittanceCommand.requested(
                    UUID.randomUUID().toString(),
                    fromAccountNumber,
                    toAccountNumber,
                    amount
            );

            return commandRepository.save(command);
        });
    }

    private void complete(Long commandId, ExternalRemittanceResult result) {
        transactionTemplate.executeWithoutResult(status -> {
            RemittanceCommand command = commandRepository.findById(commandId)
                    .orElseThrow(() -> new IllegalArgumentException("송금 요청이 없어요."));

            if (result.isSuccess()) {
                command.complete(result.externalTransactionId());
                return;
            }

            command.fail(result.failureReason());

            Account account = accountRepository.findByAccountNumber(command.getFromAccountNumber())
                    .orElseThrow(() -> new IllegalArgumentException("출금 계좌가 없어요."));

            account.deposit(command.getAmount());
        });
    }
}
```

이 코드에서 핵심은 `remit()` 자체에는 트랜잭션이 없다는 점이에요.

```text
remit()
  |
  |-- prepare() 내부 TransactionTemplate
  |      |
  |      |-- 출금
  |      |-- 송금 요청 저장
  |      v
  |   커밋
  |
  |-- 외부 송금사 API 호출
  |
  |-- complete() 내부 TransactionTemplate
         |
         |-- 성공/실패 결과 반영
         |-- 실패 시 보상 입금
         v
      커밋
```

`@Transactional`로도 비슷하게 만들 수 있지만, 그러려면 보통 `prepare()`와 `complete()`를 별도 Spring Bean으로 분리해야 해요. 같은 클래스 내부 호출은 프록시를 타지 않기 때문이에요.

반면 `TransactionTemplate`은 코드 블록을 직접 실행하는 방식이라 self-invocation 문제에서 비교적 자유로워요.

---

## executeWithoutResult(): 반환값이 없을 때 사용해요

반환값이 필요 없는 작업은 `executeWithoutResult()`가 더 읽기 좋아요.

예를 들어 송금 실패 이력을 따로 저장한다고 해볼게요.

```java
public void markAsUnknown(Long commandId, String reason) {
    transactionTemplate.executeWithoutResult(status -> {
        RemittanceCommand command = commandRepository.findById(commandId)
                .orElseThrow(() -> new IllegalArgumentException("송금 요청이 없어요."));

        command.unknown(reason);
    });
}
```

트랜잭션 안에서 값을 반환할 필요가 없다면 이 방식이 더 명확해요.

---

## 수동 롤백 처리하기

`TransactionTemplate` 안에서는 `TransactionStatus`를 통해 수동으로 롤백 여부를 지정할 수 있어요.

```java
public boolean withdrawIfPossible(String accountNumber, BigDecimal amount) {
    return transactionTemplate.execute(status -> {
        Account account = accountRepository.findByAccountNumber(accountNumber)
                .orElseThrow(() -> new IllegalArgumentException("계좌가 없어요."));

        if (account.getBalance().compareTo(amount) < 0) {
            status.setRollbackOnly();
            return false;
        }

        account.withdraw(amount);
        return true;
    });
}
```

여기서는 잔액이 부족하면 예외를 던지지 않고 `false`를 반환해요. 대신 `status.setRollbackOnly()`를 호출해서 트랜잭션은 롤백되도록 만들어요.

다만 이 패턴은 너무 자주 쓰면 코드가 애매해질 수 있어요. 실패를 예외로 볼지, 정상적인 비즈니스 결과로 볼지 먼저 정하는 게 좋아요.

---

## 예외가 발생하면 어떻게 될까요?

`TransactionTemplate` 블록 안에서 런타임 예외가 발생하면 트랜잭션은 롤백돼요.

```java
public void withdraw(String accountNumber, BigDecimal amount) {
    transactionTemplate.executeWithoutResult(status -> {
        Account account = accountRepository.findByAccountNumber(accountNumber)
                .orElseThrow(() -> new IllegalArgumentException("계좌가 없어요."));

        account.withdraw(amount);

        throw new IllegalStateException("일부러 예외를 발생시켜요.");
    });
}
```

이 경우 `account.withdraw(amount)`까지 실행됐더라도 최종적으로 롤백돼요.

체크 예외를 다뤄야 한다면 람다 안에서 직접 처리하거나 런타임 예외로 감싸야 해요.

```java
public void remitWithCheckedException() {
    transactionTemplate.executeWithoutResult(status -> {
        try {
            riskyOperation();
        } catch (IOException e) {
            throw new IllegalStateException("처리 중 I/O 오류가 발생했어요.", e);
        }
    });
}
```

`@Transactional(rollbackFor = Exception.class)`처럼 선언적으로 지정하는 방식과는 결이 조금 달라요. `TransactionTemplate`에서는 코드 안에서 예외 처리 정책이 더 직접적으로 드러나요.

---

## 전파 레벨도 설정할 수 있어요

`TransactionTemplate`도 전파 레벨을 설정할 수 있어요.

예를 들어 감사 로그를 별도 트랜잭션으로 저장하고 싶다면 `REQUIRES_NEW` 성격의 템플릿을 하나 만들 수 있어요.

```java
@Bean
public TransactionTemplate auditTransactionTemplate(
        PlatformTransactionManager transactionManager
) {
    TransactionTemplate template = new TransactionTemplate(transactionManager);
    template.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    return template;
}
```

그리고 감사 로그 저장 서비스에서 사용해요.

```java
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class AuditLogService {

    private final TransactionTemplate auditTransactionTemplate;
    private final AuditLogRepository auditLogRepository;

    public AuditLogService(
            @Qualifier("auditTransactionTemplate") TransactionTemplate auditTransactionTemplate,
            AuditLogRepository auditLogRepository
    ) {
        this.auditTransactionTemplate = auditTransactionTemplate;
        this.auditLogRepository = auditLogRepository;
    }

    public void save(String eventType, String message) {
        auditTransactionTemplate.executeWithoutResult(status -> {
            auditLogRepository.save(new AuditLog(eventType, message));
        });
    }
}
```

이렇게 하면 바깥 트랜잭션이 롤백되더라도 감사 로그는 별도 트랜잭션으로 커밋될 수 있어요.

물론 이 경우에도 주의할 점은 있어요. `REQUIRES_NEW`는 기존 트랜잭션을 잠시 중단하고 새 트랜잭션을 만들기 때문에, 커넥션 사용량과 흐름 복잡도가 늘어날 수 있어요.

---

## 읽기 전용 트랜잭션에도 사용할 수 있어요

조회 전용 템플릿을 따로 만들 수도 있어요.

```java
@Bean
public TransactionTemplate readOnlyTransactionTemplate(
        PlatformTransactionManager transactionManager
) {
    TransactionTemplate template = new TransactionTemplate(transactionManager);
    template.setReadOnly(true);
    return template;
}
```

사용 코드는 이런 느낌이에요.

```java
public RemittanceCommand getCommand(Long commandId) {
    return readOnlyTransactionTemplate.execute(status ->
            commandRepository.findById(commandId)
                    .orElseThrow(() -> new IllegalArgumentException("송금 요청이 없어요."))
    );
}
```

하지만 단순 조회는 보통 `@Transactional(readOnly = true)`가 더 깔끔해요. `TransactionTemplate`은 정말 코드 블록 단위 제어가 필요한 곳에 쓰는 편이 좋아요.

---

## TransactionTemplate을 쓸 때 좋은 경우

제 기준으로는 이런 상황에서 `TransactionTemplate`이 꽤 유용해요.

### 1. 한 메서드 안에서 트랜잭션 경계를 명확히 나누고 싶을 때

```java
public void process() {
    transactionTemplate.executeWithoutResult(status -> {
        // DB 작업 1
    });

    // 트랜잭션 밖 작업

    transactionTemplate.executeWithoutResult(status -> {
        // DB 작업 2
    });
}
```

이런 코드는 읽는 사람이 트랜잭션 경계를 바로 볼 수 있어요.

### 2. 외부 API 호출을 DB 트랜잭션 밖으로 빼고 싶을 때

```java
public void remit(...) {
    RemittanceCommand command = transactionTemplate.execute(status -> {
        // 송금 요청 저장
        // 출금 처리
        return savedCommand;
    });

    ExternalRemittanceResult result = externalRemittanceClient.request(...);

    transactionTemplate.executeWithoutResult(status -> {
        // 결과 반영
    });
}
```

외부 API 호출은 DB 커넥션을 잡은 채 오래 기다리면 위험할 수 있어요. 트래픽이 늘어나면 커넥션 풀이 빠르게 고갈될 수 있거든요.

물론 외부 호출을 트랜잭션 밖으로 뺀다고 모든 문제가 해결되지는 않아요. 멱등키, 상태 관리, 재시도, 보상 처리를 같이 설계해야 해요.

### 3. self-invocation 문제를 피하고 싶을 때

`@Transactional`은 같은 클래스 내부 호출에서 동작하지 않는 문제가 있어요.

```java
public void outer() {
    inner(); // 프록시를 타지 않아요.
}

@Transactional
public void inner() {
    ...
}
```

`TransactionTemplate`은 직접 트랜잭션 블록을 실행하므로 이런 프록시 문제를 피할 수 있어요.

```java
public void outer() {
    transactionTemplate.executeWithoutResult(status -> {
        innerLogic();
    });
}
```

다만 이게 항상 더 좋은 건 아니에요. 트랜잭션이 필요한 책임이 커지면 서비스를 분리하는 게 더 읽기 좋은 경우도 많아요.

---

## TransactionTemplate을 남용하면 생기는 문제

`TransactionTemplate`은 편하지만, 모든 곳에 쓰면 코드가 지저분해질 수 있어요.

아래처럼 비즈니스 로직보다 트랜잭션 제어 코드가 더 눈에 띄기 시작하면 조심해야 해요.

```java
public void doSomething() {
    transactionTemplate.executeWithoutResult(status -> {
        ...
        transactionTemplate.executeWithoutResult(innerStatus -> {
            ...
        });
        ...
    });
}
```

이런 코드는 나중에 읽기가 힘들어요.

보통은 이렇게 기준을 잡는 편이 좋아요.

| 상황 | 추천 |
|---|---|
| 일반적인 서비스 메서드 전체를 하나의 트랜잭션으로 묶기 | `@Transactional` |
| 메서드 안에서 트랜잭션 범위를 짧게 나누기 | `TransactionTemplate` |
| 전파 레벨 정책을 서비스 책임으로 명확히 분리하기 | 별도 서비스 + `@Transactional` |
| 동적 롤백/커밋 제어가 필요한 특수 흐름 | `TransactionTemplate` |

`TransactionTemplate`은 `@Transactional`의 대체제가 아니라 보완재에 가까워요.

---

## 테스트 코드로 확인해보기

송금 준비 단계에서 출금은 커밋되고, 외부 API 이후 실패 처리는 별도 트랜잭션에서 보상 입금된다고 해볼게요.

```java
import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class RemittanceServiceTest {

    @Autowired
    RemittanceService remittanceService;

    @Autowired
    AccountRepository accountRepository;

    @Autowired
    RemittanceCommandRepository commandRepository;

    @Test
    void 외부_송금이_실패하면_실패_상태로_저장하고_출금액을_보상입금한다() {
        accountRepository.save(new Account("A-001", BigDecimal.valueOf(100_000)));

        remittanceService.remit(
                "A-001",
                "B-001",
                BigDecimal.valueOf(10_000)
        );

        Account account = accountRepository.findByAccountNumber("A-001").orElseThrow();
        RemittanceCommand command = commandRepository.findAll().get(0);

        assertThat(command.getStatus()).isEqualTo(RemittanceStatus.FAILED);
        assertThat(account.getBalance()).isEqualByComparingTo("100000");
    }
}
```

이 테스트는 외부 API 클라이언트를 실패 응답으로 mocking했다는 전제가 있어요.

```java
public interface ExternalRemittanceClient {
    ExternalRemittanceResult request(
            String requestId,
            String fromAccountNumber,
            String toAccountNumber,
            BigDecimal amount
    );
}
```

```java
public record ExternalRemittanceResult(
        boolean success,
        String externalTransactionId,
        String failureReason
) {

    public static ExternalRemittanceResult success(String externalTransactionId) {
        return new ExternalRemittanceResult(true, externalTransactionId, null);
    }

    public static ExternalRemittanceResult fail(String failureReason) {
        return new ExternalRemittanceResult(false, null, failureReason);
    }

    public boolean isSuccess() {
        return success;
    }
}
```

실제 테스트에서는 `@MockBean`이나 테스트 전용 `ExternalRemittanceClient` 구현체를 넣어서 성공/실패/타임아웃 케이스를 나눠보면 좋아요.

---

## 정리

`TransactionTemplate`은 트랜잭션을 코드 블록 단위로 직접 다루고 싶을 때 사용하는 도구예요.

대부분의 상황에서는 `@Transactional`이 더 간단하고 읽기 좋아요. 하지만 송금, 결제, 정산처럼 외부 시스템과 DB 상태가 함께 엮이는 흐름에서는 트랜잭션 경계를 더 섬세하게 나눠야 할 때가 있어요.

그럴 때 `TransactionTemplate`을 사용하면 이런 의도를 코드에 직접 표현할 수 있어요.

- 여기까지는 DB 트랜잭션으로 묶어요.
- 여기서부터는 트랜잭션 밖에서 외부 API를 호출해요.
- 외부 응답을 받은 뒤 다시 새 트랜잭션으로 결과를 반영해요.
- 실패하면 상태를 남기고 보상 처리를 해요.

결국 중요한 건 `TransactionTemplate` 자체가 아니에요.

중요한 건 트랜잭션 경계를 어디에 둘지, 외부 시스템 호출과 DB 상태 변경을 어떻게 분리할지, 실패했을 때 어떤 상태를 남길지예요.

트랜잭션은 기술이기도 하지만, 동시에 서비스의 실패 기준을 정하는 설계이기도 해요.  
그래서 `TransactionTemplate`은 그 설계를 코드 안에서 조금 더 선명하게 보여주는 도구라고 보면 좋을 것 같아요.
