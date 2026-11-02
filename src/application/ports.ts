import { InboxMessage, OutboxMessage } from '../domain/messaging';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WageringUnitOfWork {
  findWalletByIdForUpdate(walletId: string): Promise<Wallet | null>;
  findWalletById(walletId: string): Promise<Wallet | null>;
  findWalletByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  saveWallet(wallet: Wallet): Promise<void>;

  findTransactionById(transactionId: string): Promise<WagerTransaction | null>;
  findTransactionByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findTransactionsByReferenceId(referenceTransactionId: string): Promise<WagerTransaction[]>;
  findPendingTransactionsByReferenceId(referenceTransactionId: string): Promise<WagerTransaction[]>;
  saveTransaction(tx: WagerTransaction): Promise<void>;

  saveLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  findLedgerEntriesByWalletId(
    walletId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: WalletLedgerEntry[]; total: number }>;
  findAllLedgerEntriesByWalletId(walletId: string): Promise<WalletLedgerEntry[]>;

  findInboxByMessageId(messageId: string): Promise<InboxMessage | null>;
  saveInboxMessage(msg: InboxMessage): Promise<void>;

  saveOutboxMessage(msg: OutboxMessage): Promise<void>;
  findPendingOutboxMessages(limit: number): Promise<OutboxMessage[]>;
}

export interface UnitOfWorkRunner {
  runInTransaction<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T>;
}