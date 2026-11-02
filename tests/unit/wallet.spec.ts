import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

describe('Wallet & WalletLedgerEntry', () => {
  it('deve criar uma carteira válida com versão inicial 1', () => {
    const wallet = Wallet.create({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: Money.from('100.00', 'BRL'),
    });

    expect(wallet.getId()).toBe('wallet-1');
    expect(wallet.getBalance().getAmount()).toBe('100.00');
    expect(wallet.getVersion()).toBe(1);
  });

  it('deve debitar valor, incrementar versão e gerar recibo DEBIT no ledger', () => {
    const wallet = Wallet.create({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: Money.from('100.00', 'BRL'),
    });

    const entry = wallet.debit(Money.from('30.00', 'BRL'), 'tx-1', 'ledger-1');

    expect(wallet.getBalance().getAmount()).toBe('70.00');
    expect(wallet.getVersion()).toBe(2);

    expect(entry.getDirection()).toBe(LedgerDirection.DEBIT);
    expect(entry.getBalanceBefore().getAmount()).toBe('100.00');
    expect(entry.getBalanceAfter().getAmount()).toBe('70.00');
  });

  it('deve creditar valor, incrementar versão e gerar recibo CREDIT no ledger', () => {
    const wallet = Wallet.create({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: Money.from('50.00', 'BRL'),
    });

    const entry = wallet.credit(Money.from('25.00', 'BRL'), 'tx-2', 'ledger-2');

    expect(wallet.getBalance().getAmount()).toBe('75.00');
    expect(wallet.getVersion()).toBe(2);
    expect(entry.getDirection()).toBe(LedgerDirection.CREDIT);
  });

  it('deve bloquear débito quando saldo for insuficiente ou moeda for diferente', () => {
    const wallet = Wallet.create({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: Money.from('20.00', 'BRL'),
    });

    expect(() => wallet.debit(Money.from('50.00', 'BRL'), 'tx-3', 'ledger-3')).toThrow();
    expect(() => wallet.credit(Money.from('10.00', 'USD'), 'tx-4', 'ledger-4')).toThrow();
  });
});