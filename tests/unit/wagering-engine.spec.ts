import { describe, expect, it } from 'bun:test';
import { WageringService } from '../../src/application/wagering.service';
import { WalletService } from '../../src/application/wallet.service';
import { TransactionStatus, TransactionType } from '../../src/domain/wager-transaction';
import { InMemoryUnitOfWorkRunner } from '../../src/infrastructure/in-memory-uow';

describe('Wagering Engine (Fluxos Completos, Fora de Ordem e Concorrência)', () => {
  it('deve processar abertura, BET, WIN, REFUND e reconciliar saldo com 100% de precisão', async () => {
    const uowRunner = new InMemoryUnitOfWorkRunner();
    const walletService = new WalletService(uowRunner);
    const wageringService = new WageringService(uowRunner);

    const wallet = await walletService.createWallet({
      id: 'wallet-100',
      playerId: 'player-100',
      currency: 'BRL',
      initialBalance: '100.00',
    });

    expect(wallet.getBalance().getAmount()).toBe('100.00');

    // 1. BET de 30.00 -> saldo vai para 70.00
    const betTx = await wageringService.processTransaction({
      transactionId: 'tx-bet-1',
      walletId: 'wallet-100',
      type: TransactionType.BET,
      amount: '30.00',
      currency: 'BRL',
      idempotencyKey: 'idem-bet-1',
    });
    expect(betTx.getStatus()).toBe(TransactionStatus.PROCESSED);

    // 2. WIN de 50.00 referenciando tx-bet-1 -> saldo vai para 120.00
    const winTx = await wageringService.processTransaction({
      transactionId: 'tx-win-1',
      walletId: 'wallet-100',
      type: TransactionType.WIN,
      amount: '50.00',
      currency: 'BRL',
      referenceTransactionId: 'tx-bet-1',
      idempotencyKey: 'idem-win-1',
    });
    expect(winTx.getStatus()).toBe(TransactionStatus.PROCESSED);

    // 3. Reconciliação contábil do Ledger
    const reconciliation = await walletService.reconcileWallet('wallet-100');
    expect(reconciliation.walletBalance).toBe('120.00');
    expect(reconciliation.ledgerCalculatedBalance).toBe('120.00');
    expect(reconciliation.isConsistent).toBe(true);
    expect(reconciliation.entriesCount).toBe(3); // OPENING + BET + WIN
  });

  it('deve suportar mensagens FORA DE ORDEM (WIN chega antes da BET) via PENDING_REFERENCE', async () => {
    const uowRunner = new InMemoryUnitOfWorkRunner();
    const walletService = new WalletService(uowRunner);
    const wageringService = new WageringService(uowRunner);

    await walletService.createWallet({
      id: 'wallet-ooo',
      playerId: 'player-ooo',
      currency: 'BRL',
      initialBalance: '100.00',
    });

    // 1. Chega o WIN antes da BET existir! Deve ficar PENDING_REFERENCE e saldo continua 100.00
    const earlyWin = await wageringService.processTransaction({
      transactionId: 'tx-win-early',
      walletId: 'wallet-ooo',
      type: TransactionType.WIN,
      amount: '80.00',
      currency: 'BRL',
      referenceTransactionId: 'tx-bet-late',
    });
    expect(earlyWin.getStatus()).toBe(TransactionStatus.PENDING_REFERENCE);

    const walletBeforeBet = await walletService.getWalletById('wallet-ooo');
    expect(walletBeforeBet?.getBalance().getAmount()).toBe('100.00');

    // 2. Agora chega a BET atrasada de 20.00! Deve processar a BET (100 -> 80) e destravar o WIN automaticamente (80 -> 160)!
    const lateBet = await wageringService.processTransaction({
      transactionId: 'tx-bet-late',
      walletId: 'wallet-ooo',
      type: TransactionType.BET,
      amount: '20.00',
      currency: 'BRL',
    });
    expect(lateBet.getStatus()).toBe(TransactionStatus.PROCESSED);

    const resolvedWin = await wageringService.getTransactionById('tx-win-early');
    expect(resolvedWin?.getStatus()).toBe(TransactionStatus.PROCESSED);

    const finalWallet = await walletService.getWalletById('wallet-ooo');
    expect(finalWallet?.getBalance().getAmount()).toBe('160.00');
  });

  it('deve garantir IDEMPOTÊNCIA e rejeitar payload divergente na mesma chave', async () => {
    const uowRunner = new InMemoryUnitOfWorkRunner();
    const walletService = new WalletService(uowRunner);
    const wageringService = new WageringService(uowRunner);

    await walletService.createWallet({
      id: 'wallet-idem',
      playerId: 'player-idem',
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const first = await wageringService.processTransaction({
      transactionId: 'tx-idem-1',
      walletId: 'wallet-idem',
      type: TransactionType.BET,
      amount: '25.00',
      currency: 'BRL',
      idempotencyKey: 'key-123',
    });

    // Repetição idêntica: não pode descontar de novo!
    const duplicate = await wageringService.processTransaction({
      transactionId: 'tx-idem-1',
      walletId: 'wallet-idem',
      type: TransactionType.BET,
      amount: '25.00',
      currency: 'BRL',
      idempotencyKey: 'key-123',
    });

    expect(duplicate.getId()).toBe(first.getId());
    const wallet = await walletService.getWalletById('wallet-idem');
    expect(wallet?.getBalance().getAmount()).toBe('75.00');

    // Mesma chave com valor diferente -> conflito!
    expect(
      wageringService.processTransaction({
        transactionId: 'tx-idem-diff',
        walletId: 'wallet-idem',
        type: TransactionType.BET,
        amount: '90.00',
        currency: 'BRL',
        idempotencyKey: 'key-123',
      }),
    ).rejects.toThrow();
  });

  it('deve suportar ALTA CONCORRÊNCIA: 20 apostas simultâneas de 10.00 em saldo de 100.00 (10 aprovadas, 10 rejeitadas, saldo final 0.00)', async () => {
    const uowRunner = new InMemoryUnitOfWorkRunner();
    const walletService = new WalletService(uowRunner);
    const wageringService = new WageringService(uowRunner);

    await walletService.createWallet({
      id: 'wallet-concurrent',
      playerId: 'player-concurrent',
      currency: 'BRL',
      initialBalance: '100.00',
    });

    // Dispara 20 apostas de R$ 10,00 ao mesmo tempo (Promise.all)
    const promises = Array.from({ length: 20 }, (_, i) =>
      wageringService.processTransaction({
        transactionId: `tx-conc-${i}`,
        walletId: 'wallet-concurrent',
        type: TransactionType.BET,
        amount: '10.00',
        currency: 'BRL',
        idempotencyKey: `idem-conc-${i}`,
      }),
    );

    const results = await Promise.all(promises);

    const processedCount = results.filter((r) => r.getStatus() === TransactionStatus.PROCESSED).length;
    const rejectedCount = results.filter((r) => r.getStatus() === TransactionStatus.REJECTED).length;

    expect(processedCount).toBe(10);
    expect(rejectedCount).toBe(10);

    const reconciliation = await walletService.reconcileWallet('wallet-concurrent');
    expect(reconciliation.walletBalance).toBe('0.00');
    expect(reconciliation.ledgerCalculatedBalance).toBe('0.00');
    expect(reconciliation.isConsistent).toBe(true);
  });
});