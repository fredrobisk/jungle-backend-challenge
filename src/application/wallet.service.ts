import { randomUUID } from 'crypto';
import { Money } from '../domain/money';
import { OutboxMessage } from '../domain/messaging';
import { TransactionType, WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { UnitOfWorkRunner } from './ports';

export interface CreateWalletInput {
  id?: string;
  playerId: string;
  currency: string;
  initialBalance?: string;
}

export interface ReconciliationResult {
  walletId: string;
  currency: string;
  walletBalance: string;
  ledgerCalculatedBalance: string;
  isConsistent: boolean;
  entriesCount: number;
}

export class WalletService {
  constructor(private readonly uowRunner: UnitOfWorkRunner) {}

  public async createWallet(input: CreateWalletInput): Promise<Wallet> {
    const initialAmount = input.initialBalance ?? '0.00';
    const initialMoney = Money.from(initialAmount, input.currency);
    const walletId = input.id ?? randomUUID();

    return this.uowRunner.runInTransaction(async (uow) => {
      const existing = await uow.findWalletByPlayerAndCurrency(input.playerId, input.currency);
      if (existing) {
        throw new Error(`Wallet already exists for player ${input.playerId} in currency ${input.currency}.`);
      }

      const zeroMoney = Money.from('0.00', input.currency);
      const wallet = Wallet.create({
        id: walletId,
        playerId: input.playerId,
        currency: input.currency,
        balance: zeroMoney,
      });

      await uow.saveWallet(wallet);

      if (initialMoney.getCents() > 0n) {
        const openingTx = WagerTransaction.createProcessed({
          id: randomUUID(),
          walletId: wallet.getId(),
          type: TransactionType.OPENING,
          money: initialMoney,
          idempotencyKey: `opening:${wallet.getId()}`,
        });

        const ledgerEntry = wallet.credit(initialMoney, openingTx.getId(), randomUUID());

        await uow.saveWallet(wallet);
        await uow.saveTransaction(openingTx);
        await uow.saveLedgerEntry(ledgerEntry);

        const outbox = OutboxMessage.createPending({
          id: randomUUID(),
          eventType: 'wallet.transaction.processed',
          aggregateId: wallet.getId(),
          payload: {
            transactionId: openingTx.getId(),
            walletId: wallet.getId(),
            type: openingTx.getType(),
            amount: initialMoney.getAmount(),
            currency: initialMoney.getCurrency(),
            status: openingTx.getStatus(),
          },
        });
        await uow.saveOutboxMessage(outbox);
      }

      return wallet;
    });
  }

  public async getWalletById(walletId: string): Promise<Wallet | null> {
    return this.uowRunner.runInTransaction((uow) => uow.findWalletById(walletId));
  }

  public async getLedger(
    walletId: string,
    limit = 50,
    offset = 0,
  ): Promise<{ items: WalletLedgerEntry[]; total: number }> {
    return this.uowRunner.runInTransaction((uow) =>
      uow.findLedgerEntriesByWalletId(walletId, limit, offset),
    );
  }

  public async reconcileWallet(walletId: string): Promise<ReconciliationResult> {
    return this.uowRunner.runInTransaction(async (uow) => {
      const wallet = await uow.findWalletById(walletId);
      if (!wallet) {
        throw new Error(`Wallet ${walletId} not found.`);
      }

      const entries = await uow.findAllLedgerEntriesByWalletId(walletId);
      let calculated = Money.from('0.00', wallet.getCurrency());

      for (const entry of entries) {
        if (entry.getDirection() === LedgerDirection.CREDIT) {
          calculated = calculated.add(entry.getMoney());
        } else {
          calculated = calculated.subtract(entry.getMoney());
        }
      }

      return {
        walletId: wallet.getId(),
        currency: wallet.getCurrency(),
        walletBalance: wallet.getBalance().getAmount(),
        ledgerCalculatedBalance: calculated.getAmount(),
        isConsistent: wallet.getBalance().equals(calculated),
        entriesCount: entries.length,
      };
    });
  }
}