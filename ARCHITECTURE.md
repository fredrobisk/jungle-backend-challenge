# Arquitetura — Distributed Wagering Processor

## 1. Visão Geral e Divisão de Camadas (DDD / Clean Architecture)

O sistema foi desenhado separando estritamente as regras financeiras de detalhes de infraestrutura:

- **`src/domain/`**: Núcleo puro de domínio, sem dependências externas.
  - **`Money` (`money.ts`)**: Value Object imutável que representa valores monetários utilizando **centavos inteiros em `bigint`** internamente, eliminando 100% dos erros de precisão de ponto flutuante (`IEEE 754`) sem necessitar de bibliotecas externas pesadas. Valida entradas via Regex (`/^\d+\.\d{2}$/`) e impede operações entre moedas distintas (`ISO-4217`).
  - **`Wallet` (`wallet.ts`)**: Aggregate Root responsável por proteger a invariante principal do sistema (**proibição de saldo negativo**), controlar o versionamento (`version`) e emitir invariavelmente um recibo contábil (`WalletLedgerEntry`) a cada mutação de saldo (`credit` / `debit`).
  - **`WalletLedgerEntry` (`wallet-ledger-entry.ts`)**: Entidade imutável (*append-only*) que registra `direction` (`DEBIT` ou `CREDIT`), `money`, `balanceBefore` e `balanceAfter`.
  - **`WagerTransaction` (`wager-transaction.ts`)**: Entidade que modela o ciclo de vida das operações (`OPENING`, `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) e as transições explícitas de status (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`).
  - **`InboxMessage` & `OutboxMessage` (`messaging.ts`)**: Entidades para garantia de deduplicação de consumo assíncrono (Inbox Pattern) e publicação transacional de eventos (Transactional Outbox Pattern).

- **`src/application/`**: Orquestração dos casos de uso (`WalletService` e `WageringService`) através da abstração `UnitOfWorkRunner` (`ports.ts`).
- **`src/infrastructure/`**: Adaptadores de persistência (`PostgresUnitOfWorkRunner` com `SELECT ... FOR UPDATE` e `InMemoryUnitOfWorkRunner` com fila de mutex por carteira) e camada HTTP (`http-server.ts`).

## 2. Consistência, Concorrência e Idempotência

1. **Serialização por Carteira (Concorrência)**:
   No PostgreSQL, toda operação sobre uma carteira adquire um lock pessimista de linha via `SELECT * FROM wallets WHERE id = $1 FOR UPDATE` dentro de uma transação SQL (`BEGIN ... COMMIT`). Além disso, a tabela `wallets` possui a constraint `CHECK (balance_cents >= 0)` como última barreira no banco de dados.
2. **Idempotência e Deduplicação**:
   Suporta tanto `Idempotency-Key` via cabeçalho/payload quanto deduplicação por `transactionId` e `InboxMessage.messageId`. Se a mesma chave for reutilizada com payload divergente, o sistema lança `IDEMPOTENCY_CONFLICT` (`HTTP 409`).
3. **Mensagens Fora de Ordem (`PENDING_REFERENCE`)**:
   Quando uma transação dependente (`WIN`, `LOSS`, `REFUND`, `ROLLBACK`) chega antes de sua transação de referência (`referenceTransactionId`), ela é persistida com status `PENDING_REFERENCE` sem alterar o saldo da carteira. Assim que a transação pai é processada com sucesso, `resolveDependentPendingTransactions` reprocessa recursivamente as dependentes na mesma transação atômica.

## 3. Decisão sobre Autenticação (Seção 2 do Desafio)

Conforme descrito na Seção 2 do desafio, a autenticação não foi implementada no escopo deste teste para priorizar integralmente os invariantes financeiros, concorrência, idempotência e mensageria. Em ambiente de produção na Jungle Gaming, a autenticação e autorização seriam aplicadas na borda via API Gateway / mTLS entre os provedores de jogos (Game Providers) e o motor de apostas, combinadas com validação de assinatura HMAC (`X-Provider-Signature`) por requisição.

## 4. Como Executar e Testar

```bash
# Rodar a suíte completa de testes (Unidade, Fora de Ordem, Idempotência e Concorrência)
bun test

# Subir PostgreSQL e LocalStack (opcional para execução integrada)
docker compose up -d

# Iniciar o servidor HTTP
bun run start