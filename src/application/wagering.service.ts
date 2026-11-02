import { randomUUID } from 'crypto';
import { InboxMessage, OutboxMessage } from '../domain/messaging';
import { Money } from '../domain/money';
import {
  TransactionStatus,
  TransactionType,
  WagerTransaction,
} from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { UnitOfWorkRunner, WageringUnitOfWork } from './ports';

export interface ProcessWagerInput {
  transactionId?: string;
  walletId: string;
  type: TransactionType;
  amount: string;
  currency: string;
  referenceTransactionId?: string | null;
  idempotencyKey?: string | null;
  inboxMessageId?: string | null;
  inboxSource?: string | null;
}

export class WageringService {
  constructor(private readonly uowRunner: UnitOfWorkRunner) {}

  public async getTransactionById(transactionId: string): Promise<WagerTransaction | null> {
    return this.uowRunner.runInTransaction((uow) => uow.findTransactionById(transactionId));
  }

  public async processTransaction(input: ProcessWagerInput): Promise<WagerTransaction> {
    const money = Money.from(input.amount, input.currency);
    const txId = input.transactionId ?? randomUUID();

    return this.uowRunner.runInTransaction(async (uow) => {
      if (input.inboxMessageId) {
        const existingInbox = await uow.findInboxByMessageId(input.inboxMessageId);
        if (existingInbox) {
          const existingTx = await uow.findTransactionById(txId);
          if (existingTx) return existingTx;
        }
      }

      if (input.idempotencyKey) {
        const byIdem = await uow.findTransactionByIdempotencyKey(input.idempotencyKey);
        if (byIdem) {
          this.assertSameIdempotentPayload(byIdem, input, money);
          return byIdem;
        }
      }

      const byId = await uow.findTransactionById(txId);
      if (byId) {
        this.assertSameIdempotentPayload(byId, input, money);
        return byId;
      }

      const wallet = await uow.findWalletByIdForUpdate(input.walletId);
      if (!wallet) {
        throw new Error(`Wallet ${input.walletId} not found.`);
      }

      const tx = await this.executeTransactionLogic(uow, wallet, {
        id: txId,
        type: input.type,
        money,
        referenceTransactionId: input.referenceTransactionId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      });

      if (input.inboxMessageId) {
        const inbox = InboxMessage.createProcessed({
          id: randomUUID(),
          messageId: input.inboxMessageId,
          source: input.inboxSource ?? 'SQS',
          payload: input as unknown as Record<string, unknown>,
        });
        await uow.saveInboxMessage(inbox);
      }

      if (tx.getStatus() === TransactionStatus.PROCESSED) {
        await this.resolveDependentPendingTransactions(uow, wallet, tx);
      }

      return tx;
    });
  }

  private assertSameIdempotentPayload(
    existing: WagerTransaction,
    input: ProcessWagerInput,
    money: Money,
  ): void {
    if (
      existing.getWalletId() !== input.walletId ||
      existing.getType() !== input.type ||
      !existing.getMoney().equals(money) ||
      existing.getReferenceTransactionId() !== (input.referenceTransactionId ?? null)
    ) {
      throw new Error('IDEMPOTENCY_CONFLICT: Same key or ID used with different payload.');
    }
  }

  private async executeTransactionLogic(
    uow: WageringUnitOfWork,
    wallet: Wallet,
    params: {
      id: string;
      type: TransactionType;
      money: Money;
      referenceTransactionId: string | null;
      idempotencyKey: string | null;
    },
  ): Promise<WagerTransaction> {
    if (params.money.getCurrency() !== wallet.getCurrency()) {
      return this.rejectAndSave(uow, wallet, params, 'CURRENCY_MISMATCH');
    }

    if (params.type === TransactionType.BET) {
      if (params.money.getCents() <= 0n) {
        return this.rejectAndSave(uow, wallet, params, 'INVALID_AMOUNT');
      }
      if (!wallet.getBalance().isGreaterThanOrEqual(params.money)) {
        return this.rejectAndSave(uow, wallet, params, 'INSUFFICIENT_FUNDS');
      }

      const ledgerEntry = wallet.debit(params.money, params.id, randomUUID());
      const tx = WagerTransaction.createProcessed({
        id: params.id,
        walletId: wallet.getId(),
        type: params.type,
        money: params.money,
        referenceTransactionId: params.referenceTransactionId,
        idempotencyKey: params.idempotencyKey,
      });

      await uow.saveWallet(wallet);
      await uow.saveTransaction(tx);
      await uow.saveLedgerEntry(ledgerEntry);
      await this.emitOutboxEvent(uow, tx);
      return tx;
    }

    if (!params.referenceTransactionId) {
      return this.rejectAndSave(uow, wallet, params, 'MISSING_REFERENCE_TRANSACTION');
    }

    const refTx = await uow.findTransactionById(params.referenceTransactionId);
    if (!refTx || refTx.getStatus() === TransactionStatus.PENDING_REFERENCE) {
      const pendingTx = WagerTransaction.createPendingReference({
        id: params.id,
        walletId: wallet.getId(),
        type: params.type,
        money: params.money,
        referenceTransactionId: params.referenceTransactionId,
        idempotencyKey: params.idempotencyKey,
      });
      await uow.saveTransaction(pendingTx);
      await this.emitOutboxEvent(uow, pendingTx);
      return pendingTx;
    }

    return this.applyReferencedOperation(uow, wallet, params, refTx);
  }

  private async applyReferencedOperation(
    uow: WageringUnitOfWork,
    wallet: Wallet,
    params: {
      id: string;
      type: TransactionType;
      money: Money;
      referenceTransactionId: string | null;
      idempotencyKey: string | null;
    },
    refTx: WagerTransaction,
    existingPendingTx?: WagerTransaction,
  ): Promise<WagerTransaction> {
    if (refTx.getWalletId() !== wallet.getId()) {
      return this.finalizeRejection(uow, wallet, params, 'WALLET_MISMATCH', existingPendingTx);
    }

    if (refTx.getStatus() === TransactionStatus.REJECTED) {
      return this.finalizeRejection(uow, wallet, params, 'REFERENCE_REJECTED', existingPendingTx);
    }

    const relatedTxs = await uow.findTransactionsByReferenceId(refTx.getId());
    const processedRelated = relatedTxs.filter(
      (t) => t.getStatus() === TransactionStatus.PROCESSED && t.getId() !== params.id,
    );

    if (params.type === TransactionType.WIN) {
      if (refTx.getType() !== TransactionType.BET) {
        return this.finalizeRejection(uow, wallet, params, 'INVALID_REFERENCE_TYPE', existingPendingTx);
      }
      if (params.money.getCents() <= 0n) {
        return this.finalizeRejection(uow, wallet, params, 'INVALID_AMOUNT', existingPendingTx);
      }

      const ledgerEntry = wallet.credit(params.money, params.id, randomUUID());
      const tx = this.finalizeSuccess(params, wallet.getId(), existingPendingTx);

      await uow.saveWallet(wallet);
      await uow.saveTransaction(tx);
      await uow.saveLedgerEntry(ledgerEntry);
      await this.emitOutboxEvent(uow, tx);
      return tx;
    }

    if (params.type === TransactionType.LOSS) {
      if (refTx.getType() !== TransactionType.BET) {
        return this.finalizeRejection(uow, wallet, params, 'INVALID_REFERENCE_TYPE', existingPendingTx);
      }

      const tx = this.finalizeSuccess(params, wallet.getId(), existingPendingTx);
      await uow.saveTransaction(tx);
      await this.emitOutboxEvent(uow, tx);
      return tx;
    }

    if (params.type === TransactionType.REFUND) {
      if (refTx.getType() !== TransactionType.BET) {
        return this.finalizeRejection(uow, wallet, params, 'INVALID_REFERENCE_TYPE', existingPendingTx);
      }
      if (!params.money.equals(refTx.getMoney())) {
        return this.finalizeRejection(uow, wallet, params, 'AMOUNT_MISMATCH', existingPendingTx);
      }
      const alreadyReversed = processedRelated.some(
        (t) => t.getType() === TransactionType.REFUND || t.getType() === TransactionType.ROLLBACK,
      );
      if (alreadyReversed) {
        return this.finalizeRejection(uow, wallet, params, 'ALREADY_REVERSED', existingPendingTx);
      }

      const ledgerEntry = wallet.credit(params.money, params.id, randomUUID());
      const tx = this.finalizeSuccess(params, wallet.getId(), existingPendingTx);

      await uow.saveWallet(wallet);
      await uow.saveTransaction(tx);
      await uow.saveLedgerEntry(ledgerEntry);
      await this.emitOutboxEvent(uow, tx);
      return tx;
    }

    if (params.type === TransactionType.ROLLBACK) {
      if (refTx.getType() !== TransactionType.BET && refTx.getType() !== TransactionType.WIN) {
        return this.finalizeRejection(uow, wallet, params, 'INVALID_REFERENCE_TYPE', existingPendingTx);
      }
      if (!params.money.equals(refTx.getMoney())) {
        return this.finalizeRejection(uow, wallet, params, 'AMOUNT_MISMATCH', existingPendingTx);
      }
      const alreadyReversed = processedRelated.some(
        (t) => t.getType() === TransactionType.REFUND || t.getType() === TransactionType.ROLLBACK,
      );
      if (alreadyReversed) {
        return this.finalizeRejection(uow, wallet, params, 'ALREADY_REVERSED', existingPendingTx);
      }

      if (refTx.getType() === TransactionType.BET) {
        const ledgerEntry = wallet.credit(params.money, params.id, randomUUID());
        const tx = this.finalizeSuccess(params, wallet.getId(), existingPendingTx);
        await uow.saveWallet(wallet);
        await uow.saveTransaction(tx);
        await uow.saveLedgerEntry(ledgerEntry);
        await this.emitOutboxEvent(uow, tx);
        return tx;
      } else {
        if (!wallet.getBalance().isGreaterThanOrEqual(params.money)) {
          return this.finalizeRejection(uow, wallet, params, 'INSUFFICIENT_FUNDS', existingPendingTx);
        }
        const ledgerEntry = wallet.debit(params.money, params.id, randomUUID());
        const tx = this.finalizeSuccess(params, wallet.getId(), existingPendingTx);
        await uow.saveWallet(wallet);
        await uow.saveTransaction(tx);
        await uow.saveLedgerEntry(ledgerEntry);
        await this.emitOutboxEvent(uow, tx);
        return tx;
      }
    }

    return this.finalizeRejection(uow, wallet, params, 'UNSUPPORTED_TRANSACTION_TYPE', existingPendingTx);
  }

  private async resolveDependentPendingTransactions(
    uow: WageringUnitOfWork,
    wallet: Wallet,
    parentTx: WagerTransaction,
  ): Promise<void> {
    const pendingList = await uow.findPendingTransactionsByReferenceId(parentTx.getId());
    for (const pendingTx of pendingList) {
      const resolved = await this.applyReferencedOperation(
        uow,
        wallet,
        {
          id: pendingTx.getId(),
          type: pendingTx.getType(),
          money: pendingTx.getMoney(),
          referenceTransactionId: pendingTx.getReferenceTransactionId(),
          idempotencyKey: pendingTx.getIdempotencyKey(),
        },
        parentTx,
        pendingTx,
      );

      if (resolved.getStatus() === TransactionStatus.PROCESSED) {
        await this.resolveDependentPendingTransactions(uow, wallet, resolved);
      }
    }
  }

  private finalizeSuccess(
    params: {
      id: string;
      type: TransactionType;
      money: Money;
      referenceTransactionId: string | null;
      idempotencyKey: string | null;
    },
    walletId: string,
    existingPendingTx?: WagerTransaction,
  ): WagerTransaction {
    if (existingPendingTx) {
      existingPendingTx.markProcessed();
      return existingPendingTx;
    }
    return WagerTransaction.createProcessed({
      id: params.id,
      walletId,
      type: params.type,
      money: params.money,
      referenceTransactionId: params.referenceTransactionId,
      idempotencyKey: params.idempotencyKey,
    });
  }

  private async finalizeRejection(
    uow: WageringUnitOfWork,
    wallet: Wallet,
    params: {
      id: string;
      type: TransactionType;
      money: Money;
      referenceTransactionId: string | null;
      idempotencyKey: string | null;
    },
    reason: string,
    existingPendingTx?: WagerTransaction,
  ): Promise<WagerTransaction> {
    if (existingPendingTx) {
      existingPendingTx.markRejected(reason);
      await uow.saveTransaction(existingPendingTx);
      await this.emitOutboxEvent(uow, existingPendingTx);
      return existingPendingTx;
    }
    return this.rejectAndSave(uow, wallet, params, reason);
  }

  private async rejectAndSave(
    uow: WageringUnitOfWork,
    wallet: Wallet,
    params: {
      id: string;
      type: TransactionType;
      money: Money;
      referenceTransactionId: string | null;
      idempotencyKey: string | null;
    },
    reason: string,
  ): Promise<WagerTransaction> {
    const rejectedTx = WagerTransaction.createRejected({
      id: params.id,
      walletId: wallet.getId(),
      type: params.type,
      money: params.money,
      referenceTransactionId: params.referenceTransactionId,
      idempotencyKey: params.idempotencyKey,
      rejectionReason: reason,
    });
    await uow.saveTransaction(rejectedTx);
    await this.emitOutboxEvent(uow, rejectedTx);
    return rejectedTx;
  }

  private async emitOutboxEvent(uow: WageringUnitOfWork, tx: WagerTransaction): Promise<void> {
    const eventType =
      tx.getStatus() === TransactionStatus.PROCESSED
        ? 'wallet.transaction.processed'
        : tx.getStatus() === TransactionStatus.REJECTED
          ? 'wallet.transaction.rejected'
          : 'wallet.transaction.pending_reference';

    const outbox = OutboxMessage.createPending({
      id: randomUUID(),
      eventType,
      aggregateId: tx.getWalletId(),
      payload: {
        transactionId: tx.getId(),
        walletId: tx.getWalletId(),
        type: tx.getType(),
        amount: tx.getMoney().getAmount(),
        currency: tx.getMoney().getCurrency(),
        referenceTransactionId: tx.getReferenceTransactionId(),
        status: tx.getStatus(),
        rejectionReason: tx.getRejectionReason(),
      },
    });
    await uow.saveOutboxMessage(outbox);
  }
}