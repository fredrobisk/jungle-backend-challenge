import { UnitOfWorkRunner, WageringUnitOfWork } from '../application/ports';
import { InboxMessage, OutboxMessage, OutboxStatus } from '../domain/messaging';
import { TransactionStatus, WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export class InMemoryUnitOfWorkRunner implements UnitOfWorkRunner {
  private wallets = new Map<string, Wallet>();
  private transactions = new Map<string, WagerTransaction>();
  private ledgerEntries: WalletLedgerEntry[] = [];
  private inboxMessages = new Map<string, InboxMessage>();
  private outboxMessages = new Map<string, OutboxMessage>();
  private walletLocks = new Map<string, Promise<void>>();

  public async runInTransaction<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T> {
    let releaseLock: (() => void) | null = null;

    const snapshotWallets = new Map(
      Array.from(this.wallets.entries()).map(([k, v]) => [
        k,
        Wallet.rehydrate({
          id: v.getId(),
          playerId: v.getPlayerId(),
          currency: v.getCurrency(),
          balance: v.getBalance(),
          version: v.getVersion(),
          createdAt: v.getCreatedAt(),
          updatedAt: v.getUpdatedAt(),
        }),
      ]),
    );
    const snapshotTxs = new Map(
      Array.from(this.transactions.entries()).map(([k, v]) => [
        k,
        WagerTransaction.rehydrate({
          id: v.getId(),
          walletId: v.getWalletId(),
          type: v.getType(),
          money: v.getMoney(),
          referenceTransactionId: v.getReferenceTransactionId(),
          idempotencyKey: v.getIdempotencyKey(),
          status: v.getStatus(),
          rejectionReason: v.getRejectionReason(),
          createdAt: v.getCreatedAt(),
          processedAt: v.getProcessedAt(),
        }),
      ]),
    );
    const snapshotLedger = [...this.ledgerEntries];
    const snapshotInbox = new Map(this.inboxMessages);
    const snapshotOutbox = new Map(this.outboxMessages);

    const acquireWalletLock = async (walletId: string): Promise<void> => {
      while (this.walletLocks.has(walletId)) {
        await this.walletLocks.get(walletId);
      }
      let resolveFn!: () => void;
      const lockPromise = new Promise<void>((resolve) => {
        resolveFn = resolve;
      });
      this.walletLocks.set(walletId, lockPromise);
      releaseLock = () => {
        this.walletLocks.delete(walletId);
        resolveFn();
      };
    };

    const uow: WageringUnitOfWork = {
      findWalletByIdForUpdate: async (walletId: string) => {
        await acquireWalletLock(walletId);
        const w = this.wallets.get(walletId);
        if (!w) return null;
        return Wallet.rehydrate({
          id: w.getId(),
          playerId: w.getPlayerId(),
          currency: w.getCurrency(),
          balance: w.getBalance(),
          version: w.getVersion(),
          createdAt: w.getCreatedAt(),
          updatedAt: w.getUpdatedAt(),
        });
      },

      findWalletById: async (walletId: string) => {
        const w = this.wallets.get(walletId);
        if (!w) return null;
        return Wallet.rehydrate({
          id: w.getId(),
          playerId: w.getPlayerId(),
          currency: w.getCurrency(),
          balance: w.getBalance(),
          version: w.getVersion(),
          createdAt: w.getCreatedAt(),
          updatedAt: w.getUpdatedAt(),
        });
      },

      findWalletByPlayerAndCurrency: async (playerId: string, currency: string) => {
        for (const w of this.wallets.values()) {
          if (w.getPlayerId() === playerId && w.getCurrency() === currency) {
            return w;
          }
        }
        return null;
      },

      saveWallet: async (wallet: Wallet) => {
        this.wallets.set(
          wallet.getId(),
          Wallet.rehydrate({
            id: wallet.getId(),
            playerId: wallet.getPlayerId(),
            currency: wallet.getCurrency(),
            balance: wallet.getBalance(),
            version: wallet.getVersion(),
            createdAt: wallet.getCreatedAt(),
            updatedAt: wallet.getUpdatedAt(),
          }),
        );
      },

      findTransactionById: async (transactionId: string) => {
        return this.transactions.get(transactionId) ?? null;
      },

      findTransactionByIdempotencyKey: async (idempotencyKey: string) => {
        for (const tx of this.transactions.values()) {
          if (tx.getIdempotencyKey() === idempotencyKey) {
            return tx;
          }
        }
        return null;
      },

      findTransactionsByReferenceId: async (referenceTransactionId: string) => {
        const result: WagerTransaction[] = [];
        for (const tx of this.transactions.values()) {
          if (tx.getReferenceTransactionId() === referenceTransactionId) {
            result.push(tx);
          }
        }
        return result;
      },

      findPendingTransactionsByReferenceId: async (referenceTransactionId: string) => {
        const result: WagerTransaction[] = [];
        for (const tx of this.transactions.values()) {
          if (
            tx.getReferenceTransactionId() === referenceTransactionId &&
            tx.getStatus() === TransactionStatus.PENDING_REFERENCE
          ) {
            result.push(tx);
          }
        }
        return result;
      },

      saveTransaction: async (tx: WagerTransaction) => {
        this.transactions.set(
          tx.getId(),
          WagerTransaction.rehydrate({
            id: tx.getId(),
            walletId: tx.getWalletId(),
            type: tx.getType(),
            money: tx.getMoney(),
            referenceTransactionId: tx.getReferenceTransactionId(),
            idempotencyKey: tx.getIdempotencyKey(),
            status: tx.getStatus(),
            rejectionReason: tx.getRejectionReason(),
            createdAt: tx.getCreatedAt(),
            processedAt: tx.getProcessedAt(),
          }),
        );
      },

      saveLedgerEntry: async (entry: WalletLedgerEntry) => {
        this.ledgerEntries.push(entry);
      },

      findLedgerEntriesByWalletId: async (walletId: string, limit: number, offset: number) => {
        const all = this.ledgerEntries.filter((e) => e.getWalletId() === walletId);
        return {
          items: all.slice(offset, offset + limit),
          total: all.length,
        };
      },

      findAllLedgerEntriesByWalletId: async (walletId: string) => {
        return this.ledgerEntries.filter((e) => e.getWalletId() === walletId);
      },

      findInboxByMessageId: async (messageId: string) => {
        return this.inboxMessages.get(messageId) ?? null;
      },

      saveInboxMessage: async (msg: InboxMessage) => {
        this.inboxMessages.set(msg.getMessageId(), msg);
      },

      saveOutboxMessage: async (msg: OutboxMessage) => {
        this.outboxMessages.set(msg.getId(), msg);
      },

      findPendingOutboxMessages: async (limit: number) => {
        const result: OutboxMessage[] = [];
        for (const msg of this.outboxMessages.values()) {
          if (msg.getStatus() === OutboxStatus.PENDING) {
            result.push(msg);
            if (result.length >= limit) break;
          }
        }
        return result;
      },
    };

    try {
      return await work(uow);
    } catch (err) {
      this.wallets = snapshotWallets;
      this.transactions = snapshotTxs;
      this.ledgerEntries = snapshotLedger;
      this.inboxMessages = snapshotInbox;
      this.outboxMessages = snapshotOutbox;
      throw err;
    } finally {
      if (releaseLock) {
        (releaseLock as () => void)();
      }
    }
  }
}