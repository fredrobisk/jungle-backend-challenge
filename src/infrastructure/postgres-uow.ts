import { Pool, PoolClient } from 'pg';
import { UnitOfWorkRunner, WageringUnitOfWork } from '../application/ports';
import { InboxMessage, InboxStatus, OutboxMessage, OutboxStatus } from '../domain/messaging';
import { Money } from '../domain/money';
import {
  TransactionStatus,
  TransactionType,
  WagerTransaction,
} from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export class PostgresUnitOfWorkRunner implements UnitOfWorkRunner {
  constructor(private readonly pool: Pool) {}

  public async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        id VARCHAR(64) PRIMARY KEY,
        player_id VARCHAR(128) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_amount VARCHAR(32) NOT NULL,
        balance_cents BIGINT NOT NULL CHECK (balance_cents >= 0),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (player_id, currency)
      );

      CREATE TABLE IF NOT EXISTS wager_transactions (
        id VARCHAR(64) PRIMARY KEY,
        wallet_id VARCHAR(64) NOT NULL REFERENCES wallets(id),
        type VARCHAR(32) NOT NULL,
        amount VARCHAR(32) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_transaction_id VARCHAR(64) NULL,
        idempotency_key VARCHAR(128) NULL UNIQUE,
        status VARCHAR(32) NOT NULL,
        rejection_reason VARCHAR(64) NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tx_ref ON wager_transactions(reference_transaction_id);

      CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
        id VARCHAR(64) PRIMARY KEY,
        wallet_id VARCHAR(64) NOT NULL REFERENCES wallets(id),
        transaction_id VARCHAR(64) NOT NULL REFERENCES wager_transactions(id),
        direction VARCHAR(16) NOT NULL,
        amount VARCHAR(32) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before VARCHAR(32) NOT NULL,
        balance_after VARCHAR(32) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON wallet_ledger_entries(wallet_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS inbox_messages (
        id VARCHAR(64) PRIMARY KEY,
        message_id VARCHAR(128) NOT NULL UNIQUE,
        source VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(32) NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS outbox_messages (
        id VARCHAR(64) PRIMARY KEY,
        event_type VARCHAR(128) NOT NULL,
        aggregate_id VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(32) NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_messages(status, created_at ASC);
    `);
  }

  public async runInTransaction<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const uow = this.createUow(client);
      const result = await work(uow);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private createUow(client: PoolClient): WageringUnitOfWork {
    return {
      findWalletByIdForUpdate: async (walletId: string) => {
        const res = await client.query(
          'SELECT * FROM wallets WHERE id = $1 FOR UPDATE',
          [walletId],
        );
        if (res.rowCount === 0) return null;
        return this.mapWallet(res.rows[0]);
      },

      findWalletById: async (walletId: string) => {
        const res = await client.query('SELECT * FROM wallets WHERE id = $1', [walletId]);
        if (res.rowCount === 0) return null;
        return this.mapWallet(res.rows[0]);
      },

      findWalletByPlayerAndCurrency: async (playerId: string, currency: string) => {
        const res = await client.query(
          'SELECT * FROM wallets WHERE player_id = $1 AND currency = $2',
          [playerId, currency],
        );
        if (res.rowCount === 0) return null;
        return this.mapWallet(res.rows[0]);
      },

      saveWallet: async (wallet: Wallet) => {
        await client.query(
          `INSERT INTO wallets (id, player_id, currency, balance_amount, balance_cents, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             balance_amount = EXCLUDED.balance_amount,
             balance_cents = EXCLUDED.balance_cents,
             version = EXCLUDED.version,
             updated_at = EXCLUDED.updated_at`,
          [
            wallet.getId(),
            wallet.getPlayerId(),
            wallet.getCurrency(),
            wallet.getBalance().getAmount(),
            wallet.getBalance().getCents().toString(),
            wallet.getVersion(),
            wallet.getCreatedAt(),
            wallet.getUpdatedAt(),
          ],
        );
      },

      findTransactionById: async (transactionId: string) => {
        const res = await client.query('SELECT * FROM wager_transactions WHERE id = $1', [
          transactionId,
        ]);
        if (res.rowCount === 0) return null;
        return this.mapTransaction(res.rows[0]);
      },

      findTransactionByIdempotencyKey: async (idempotencyKey: string) => {
        const res = await client.query(
          'SELECT * FROM wager_transactions WHERE idempotency_key = $1',
          [idempotencyKey],
        );
        if (res.rowCount === 0) return null;
        return this.mapTransaction(res.rows[0]);
      },

      findTransactionsByReferenceId: async (referenceTransactionId: string) => {
        const res = await client.query(
          'SELECT * FROM wager_transactions WHERE reference_transaction_id = $1 ORDER BY created_at ASC',
          [referenceTransactionId],
        );
        return res.rows.map((r) => this.mapTransaction(r));
      },

      findPendingTransactionsByReferenceId: async (referenceTransactionId: string) => {
        const res = await client.query(
          'SELECT * FROM wager_transactions WHERE reference_transaction_id = $1 AND status = $2 ORDER BY created_at ASC',
          [referenceTransactionId, TransactionStatus.PENDING_REFERENCE],
        );
        return res.rows.map((r) => this.mapTransaction(r));
      },

      saveTransaction: async (tx: WagerTransaction) => {
        await client.query(
          `INSERT INTO wager_transactions
            (id, wallet_id, type, amount, currency, reference_transaction_id, idempotency_key, status, rejection_reason, created_at, processed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             rejection_reason = EXCLUDED.rejection_reason,
             processed_at = EXCLUDED.processed_at`,
          [
            tx.getId(),
            tx.getWalletId(),
            tx.getType(),
            tx.getMoney().getAmount(),
            tx.getMoney().getCurrency(),
            tx.getReferenceTransactionId(),
            tx.getIdempotencyKey(),
            tx.getStatus(),
            tx.getRejectionReason(),
            tx.getCreatedAt(),
            tx.getProcessedAt(),
          ],
        );
      },

      saveLedgerEntry: async (entry: WalletLedgerEntry) => {
        await client.query(
          `INSERT INTO wallet_ledger_entries
            (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            entry.getId(),
            entry.getWalletId(),
            entry.getTransactionId(),
            entry.getDirection(),
            entry.getMoney().getAmount(),
            entry.getMoney().getCurrency(),
            entry.getBalanceBefore().getAmount(),
            entry.getBalanceAfter().getAmount(),
            entry.getCreatedAt(),
          ],
        );
      },

      findLedgerEntriesByWalletId: async (walletId: string, limit: number, offset: number) => {
        const countRes = await client.query(
          'SELECT COUNT(*)::int AS total FROM wallet_ledger_entries WHERE wallet_id = $1',
          [walletId],
        );
        const res = await client.query(
          'SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3',
          [walletId, limit, offset],
        );
        return {
          items: res.rows.map((r) => this.mapLedgerEntry(r)),
          total: countRes.rows[0]?.total ?? 0,
        };
      },

      findAllLedgerEntriesByWalletId: async (walletId: string) => {
        const res = await client.query(
          'SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY created_at ASC',
          [walletId],
        );
        return res.rows.map((r) => this.mapLedgerEntry(r));
      },

      findInboxByMessageId: async (messageId: string) => {
        const res = await client.query(
          'SELECT * FROM inbox_messages WHERE message_id = $1',
          [messageId],
        );
        if (res.rowCount === 0) return null;
        const r = res.rows[0];
        return InboxMessage.rehydrate({
          id: r.id,
          messageId: r.message_id,
          source: r.source,
          payload: r.payload,
          status: r.status as InboxStatus,
          processedAt: new Date(r.processed_at),
        });
      },

      saveInboxMessage: async (msg: InboxMessage) => {
        await client.query(
          `INSERT INTO inbox_messages (id, message_id, source, payload, status, processed_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (message_id) DO NOTHING`,
          [
            msg.getId(),
            msg.getMessageId(),
            msg.getSource(),
            JSON.stringify(msg.getPayload()),
            msg.getStatus(),
            msg.getProcessedAt(),
          ],
        );
      },

      saveOutboxMessage: async (msg: OutboxMessage) => {
        await client.query(
          `INSERT INTO outbox_messages (id, event_type, aggregate_id, payload, status, attempts, created_at, published_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             attempts = EXCLUDED.attempts,
             published_at = EXCLUDED.published_at`,
          [
            msg.getId(),
            msg.getEventType(),
            msg.getAggregateId(),
            JSON.stringify(msg.getPayload()),
            msg.getStatus(),
            msg.getAttempts(),
            msg.getCreatedAt(),
            msg.getPublishedAt(),
          ],
        );
      },

      findPendingOutboxMessages: async (limit: number) => {
        const res = await client.query(
          `SELECT * FROM outbox_messages WHERE status = $1 ORDER BY created_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [OutboxStatus.PENDING, limit],
        );
        return res.rows.map((r) =>
          OutboxMessage.rehydrate({
            id: r.id,
            eventType: r.event_type,
            aggregateId: r.aggregate_id,
            payload: r.payload,
            status: r.status as OutboxStatus,
            attempts: Number(r.attempts),
            createdAt: new Date(r.created_at),
            publishedAt: r.published_at ? new Date(r.published_at) : null,
          }),
        );
      },
    };
  }

  private mapWallet(r: Record<string, any>): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.player_id,
      currency: r.currency,
      balance: Money.from(r.balance_amount, r.currency),
      version: Number(r.version),
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    });
  }

  private mapTransaction(r: Record<string, any>): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      walletId: r.wallet_id,
      type: r.type as TransactionType,
      money: Money.from(r.amount, r.currency),
      referenceTransactionId: r.reference_transaction_id,
      idempotencyKey: r.idempotency_key,
      status: r.status as TransactionStatus,
      rejectionReason: r.rejection_reason,
      createdAt: new Date(r.created_at),
      processedAt: r.processed_at ? new Date(r.processed_at) : null,
    });
  }

  private mapLedgerEntry(r: Record<string, any>): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.wallet_id,
      transactionId: r.transaction_id,
      direction: r.direction as LedgerDirection,
      money: Money.from(r.amount, r.currency),
      balanceBefore: Money.from(r.balance_before, r.currency),
      balanceAfter: Money.from(r.balance_after, r.currency),
      createdAt: new Date(r.created_at),
    });
  }
}