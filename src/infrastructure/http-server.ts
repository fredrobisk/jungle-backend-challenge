import { WageringService } from '../application/wagering.service';
import { WalletService } from '../application/wallet.service';
import { TransactionType } from '../domain/wager-transaction';

export function createHttpHandler(
  walletService: WalletService,
  wageringService: WageringService,
) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      if (method === 'GET' && path === '/health') {
        return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
      }

      if (method === 'POST' && path === '/wallets') {
        const body = (await req.json()) as Record<string, any>;
        const wallet = await walletService.createWallet({
          id: body.id,
          playerId: String(body.playerId ?? ''),
          currency: String(body.currency ?? ''),
          initialBalance: body.initialBalance ? String(body.initialBalance) : '0.00',
        });

        return Response.json(
          {
            id: wallet.getId(),
            playerId: wallet.getPlayerId(),
            currency: wallet.getCurrency(),
            balance: {
              amount: wallet.getBalance().getAmount(),
              currency: wallet.getCurrency(),
            },
            version: wallet.getVersion(),
            createdAt: wallet.getCreatedAt().toISOString(),
          },
          { status: 201 },
        );
      }

      const walletMatch = path.match(/^\/wallets\/([^/]+)$/);
      if (method === 'GET' && walletMatch) {
        const walletId = walletMatch[1]!;
        const wallet = await walletService.getWalletById(walletId);
        if (!wallet) {
          return Response.json({ error: 'WALLET_NOT_FOUND' }, { status: 404 });
        }
        return Response.json({
          id: wallet.getId(),
          playerId: wallet.getPlayerId(),
          currency: wallet.getCurrency(),
          balance: {
            amount: wallet.getBalance().getAmount(),
            currency: wallet.getCurrency(),
          },
          version: wallet.getVersion(),
          createdAt: wallet.getCreatedAt().toISOString(),
          updatedAt: wallet.getUpdatedAt().toISOString(),
        });
      }

      const ledgerMatch = path.match(/^\/wallets\/([^/]+)\/ledger$/);
      if (method === 'GET' && ledgerMatch) {
        const walletId = ledgerMatch[1]!;
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const result = await walletService.getLedger(walletId, limit, offset);
        return Response.json({
          total: result.total,
          limit,
          offset,
          items: result.items.map((e) => ({
            id: e.getId(),
            walletId: e.getWalletId(),
            transactionId: e.getTransactionId(),
            direction: e.getDirection(),
            money: {
              amount: e.getMoney().getAmount(),
              currency: e.getMoney().getCurrency(),
            },
            balanceBefore: e.getBalanceBefore().getAmount(),
            balanceAfter: e.getBalanceAfter().getAmount(),
            createdAt: e.getCreatedAt().toISOString(),
          })),
        });
      }

      const reconciliationMatch = path.match(/^\/wallets\/([^/]+)\/reconciliation$/);
      if ((method === 'POST' || method === 'GET') && reconciliationMatch) {
        const walletId = reconciliationMatch[1]!;
        const result = await walletService.reconcileWallet(walletId);
        return Response.json(result);
      }

      if (method === 'POST' && path === '/wagering/transactions') {
        const body = (await req.json()) as Record<string, any>;
        const headerIdemKey = req.headers.get('idempotency-key');
        const amountStr =
          typeof body.money === 'object' && body.money !== null
            ? String(body.money.amount)
            : String(body.amount ?? '');
        const currencyStr =
          typeof body.money === 'object' && body.money !== null
            ? String(body.money.currency)
            : String(body.currency ?? '');

        const tx = await wageringService.processTransaction({
          transactionId: body.transactionId ?? body.id,
          walletId: String(body.walletId ?? ''),
          type: body.type as TransactionType,
          amount: amountStr,
          currency: currencyStr,
          referenceTransactionId: body.referenceTransactionId ?? null,
          idempotencyKey: headerIdemKey ?? body.idempotencyKey ?? null,
        });

        return Response.json(
          {
            id: tx.getId(),
            walletId: tx.getWalletId(),
            type: tx.getType(),
            money: {
              amount: tx.getMoney().getAmount(),
              currency: tx.getMoney().getCurrency(),
            },
            referenceTransactionId: tx.getReferenceTransactionId(),
            idempotencyKey: tx.getIdempotencyKey(),
            status: tx.getStatus(),
            rejectionReason: tx.getRejectionReason(),
            createdAt: tx.getCreatedAt().toISOString(),
            processedAt: tx.getProcessedAt()?.toISOString() ?? null,
          },
          { status: 200 },
        );
      }

      const txMatch = path.match(/^\/wagering\/transactions\/([^/]+)$/);
      if (method === 'GET' && txMatch) {
        const txId = txMatch[1]!;
        const tx = await wageringService.getTransactionById(txId);
        if (!tx) {
          return Response.json({ error: 'TRANSACTION_NOT_FOUND' }, { status: 404 });
        }
        return Response.json({
          id: tx.getId(),
          walletId: tx.getWalletId(),
          type: tx.getType(),
          money: {
            amount: tx.getMoney().getAmount(),
            currency: tx.getMoney().getCurrency(),
          },
          referenceTransactionId: tx.getReferenceTransactionId(),
          idempotencyKey: tx.getIdempotencyKey(),
          status: tx.getStatus(),
          rejectionReason: tx.getRejectionReason(),
          createdAt: tx.getCreatedAt().toISOString(),
          processedAt: tx.getProcessedAt()?.toISOString() ?? null,
        });
      }

      return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    } catch (err: any) {
      const message = err instanceof Error ? err.message : 'Internal error';
      if (message.includes('IDEMPOTENCY_CONFLICT') || message.includes('already exists')) {
        return Response.json({ error: message }, { status: 409 });
      }
      if (message.includes('not found')) {
        return Response.json({ error: message }, { status: 404 });
      }
      return Response.json({ error: message }, { status: 400 });
    }
  };
}