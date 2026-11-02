import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { WageringService } from '../../src/application/wagering.service';
import { WalletService } from '../../src/application/wallet.service';
import { TransactionStatus, TransactionType } from '../../src/domain/wager-transaction';
import { PostgresUnitOfWorkRunner } from '../../src/infrastructure/postgres-uow';
import { OutboxRelayWorker, SqsPublisherPort } from '../../src/infrastructure/sqs-worker';

const dbUrl = process.env.DATABASE_URL;

describe.skipIf(!dbUrl)('PostgreSQL Real Integration & Concurrency Suite', () => {
  let pool: Pool;
  let pgRunner: PostgresUnitOfWorkRunner;
  let walletService: WalletService;
  let wageringService: WageringService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl, max: 25 });
    pgRunner = new PostgresUnitOfWorkRunner(pool);
    await pgRunner.ensureSchema();
    walletService = new WalletService(pgRunner);
    wageringService = new WageringService(pgRunner);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it('Cenário 1 (Seção 13): A mesma aposta enviada 50 vezes em paralelo no PostgreSQL gera um ÚNICO débito', async () => {
    const walletId = `wallet-50x-${randomUUID()}`;
    await walletService.createWallet({
      id: walletId,
      playerId: `player-50x-${randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const sharedTxId = `tx-50x-${randomUUID()}`;
    const sharedIdemKey = `idem-50x-${randomUUID()}`;

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        wageringService.processTransaction({
          transactionId: sharedTxId,
          walletId,
          type: TransactionType.BET,
          amount: '30.00',
          currency: 'BRL',
          idempotencyKey: sharedIdemKey,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const reconciliation = await walletService.reconcileWallet(walletId);
    expect(reconciliation.walletBalance).toBe('70.00');
    expect(reconciliation.ledgerCalculatedBalance).toBe('70.00');
    expect(reconciliation.isConsistent).toBe(true);
    expect(reconciliation.entriesCount).toBe(2);
  });

  it('Cenário 2 (Seção 13): Operações concorrentes disputando saldo na mesma Wallet no PostgreSQL (SELECT FOR UPDATE)', async () => {
    const walletId = `wallet-race-${randomUUID()}`;
    await walletService.createWallet({
      id: walletId,
      playerId: `player-race-${randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const bets = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        wageringService.processTransaction({
          transactionId: `tx-race-${walletId}-${i}`,
          walletId,
          type: TransactionType.BET,
          amount: '10.00',
          currency: 'BRL',
          idempotencyKey: `idem-race-${walletId}-${i}`,
        }),
      ),
    );

    const processed = bets.filter((b) => b.getStatus() === TransactionStatus.PROCESSED);
    const rejected = bets.filter((b) => b.getStatus() === TransactionStatus.REJECTED);

    expect(processed.length).toBe(10);
    expect(rejected.length).toBe(15);

    const reconciliation = await walletService.reconcileWallet(walletId);
    expect(reconciliation.walletBalance).toBe('0.00');
    expect(reconciliation.ledgerCalculatedBalance).toBe('0.00');
    expect(reconciliation.isConsistent).toBe(true);
  });

  it('Cenário 7 (Seção 13): REFUND entregue antes da BET original no PostgreSQL e destravado automaticamente', async () => {
    const walletId = `wallet-refund-ooo-${randomUUID()}`;
    await walletService.createWallet({
      id: walletId,
      playerId: `player-refund-ooo-${randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const betId = `bet-late-${randomUUID()}`;
    const refundId = `refund-early-${randomUUID()}`;

    const earlyRefund = await wageringService.processTransaction({
      transactionId: refundId,
      walletId,
      type: TransactionType.REFUND,
      amount: '40.00',
      currency: 'BRL',
      referenceTransactionId: betId,
    });
    expect(earlyRefund.getStatus()).toBe(TransactionStatus.PENDING_REFERENCE);

    const lateBet = await wageringService.processTransaction({
      transactionId: betId,
      walletId,
      type: TransactionType.BET,
      amount: '40.00',
      currency: 'BRL',
    });
    expect(lateBet.getStatus()).toBe(TransactionStatus.PROCESSED);

    const updatedRefund = await wageringService.getTransactionById(refundId);
    expect(updatedRefund?.getStatus()).toBe(TransactionStatus.PROCESSED);

    const reconciliation = await walletService.reconcileWallet(walletId);
    expect(reconciliation.walletBalance).toBe('100.00');
    expect(reconciliation.ledgerCalculatedBalance).toBe('100.00');
    expect(reconciliation.isConsistent).toBe(true);
  });

  it('Cenário 6 (Seção 13): Dois publishers concorrentes sobre a mesma Outbox no PostgreSQL (FOR UPDATE SKIP LOCKED)', async () => {
    const publishedEvents: string[] = [];
    const publisher: SqsPublisherPort = {
      publish: async (_eventType, _aggregateId, payload) => {
        publishedEvents.push(String(payload.transactionId));
      },
    };

    const worker1 = new OutboxRelayWorker(pgRunner, publisher);
    const worker2 = new OutboxRelayWorker(pgRunner, publisher);

    const [count1, count2] = await Promise.all([
      worker1.processPendingBatch(50),
      worker2.processPendingBatch(50),
    ]);

    expect(count1 + count2).toBe(publishedEvents.length);
    const uniqueIds = new Set(publishedEvents);
    expect(uniqueIds.size).toBe(publishedEvents.length);
  });
});