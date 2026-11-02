import { Pool } from 'pg';
import { WageringService } from './application/wagering.service';
import { WalletService } from './application/wallet.service';
import { createHttpHandler } from './infrastructure/http-server';
import { InMemoryUnitOfWorkRunner } from './infrastructure/in-memory-uow';
import { PostgresUnitOfWorkRunner } from './infrastructure/postgres-uow';

async function bootstrap() {
  const port = Number(process.env.PORT ?? 3000);
  const dbUrl = process.env.DATABASE_URL;

  let uowRunner;
  if (dbUrl) {
    const pool = new Pool({ connectionString: dbUrl });
    const pgRunner = new PostgresUnitOfWorkRunner(pool);
    await pgRunner.ensureSchema();
    uowRunner = pgRunner;
    console.log(JSON.stringify({ level: 'info', msg: 'Connected to PostgreSQL' }));
  } else {
    uowRunner = new InMemoryUnitOfWorkRunner();
    console.log(JSON.stringify({ level: 'info', msg: 'Running with InMemory persistence' }));
  }

  const walletService = new WalletService(uowRunner);
  const wageringService = new WageringService(uowRunner);
  const handler = createHttpHandler(walletService, wageringService);

  Bun.serve({
    port,
    fetch: handler,
  });

  console.log(JSON.stringify({ level: 'info', msg: `Server listening on port ${port}` }));
}

bootstrap();