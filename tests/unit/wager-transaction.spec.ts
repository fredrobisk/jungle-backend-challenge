import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/money';
import { TransactionStatus, TransactionType, WagerTransaction } from '../../src/domain/wager-transaction';

describe('WagerTransaction', () => {
  it('deve criar transação PROCESSED corretamente', () => {
    const tx = WagerTransaction.createProcessed({
      id: 'tx-1',
      walletId: 'wallet-1',
      type: TransactionType.BET,
      money: Money.from('25.00', 'BRL'),
      idempotencyKey: 'idem-1',
    });

    expect(tx.getStatus()).toBe(TransactionStatus.PROCESSED);
    expect(tx.getRejectionReason()).toBeNull();
    expect(tx.getProcessedAt()).not.toBeNull();
  });

  it('deve criar transação REJECTED com motivo preenchido', () => {
    const tx = WagerTransaction.createRejected({
      id: 'tx-2',
      walletId: 'wallet-1',
      type: TransactionType.BET,
      money: Money.from('500.00', 'BRL'),
      rejectionReason: 'INSUFFICIENT_FUNDS',
    });

    expect(tx.getStatus()).toBe(TransactionStatus.REJECTED);
    expect(tx.getRejectionReason()).toBe('INSUFFICIENT_FUNDS');
  });

  it('deve permitir transição de PENDING_REFERENCE para PROCESSED e bloquear nova mudança', () => {
    const tx = WagerTransaction.createPendingReference({
      id: 'tx-3',
      walletId: 'wallet-1',
      type: TransactionType.WIN,
      money: Money.from('100.00', 'BRL'),
      referenceTransactionId: 'tx-bet-1',
    });

    expect(tx.getStatus()).toBe(TransactionStatus.PENDING_REFERENCE);
    expect(tx.getProcessedAt()).toBeNull();

    tx.markProcessed();
    expect(tx.getStatus()).toBe(TransactionStatus.PROCESSED);
    expect(tx.getProcessedAt()).not.toBeNull();

    expect(() => tx.markRejected('LATE_ERROR')).toThrow();
  });
});