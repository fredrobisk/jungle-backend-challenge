import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletProps {
  id: string;
  playerId: string; //confere-se id primeiarmente
  currency: string;
  balance: Money;
  version?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Wallet {
  private readonly id: string;
  private readonly playerId: string;
  private readonly currency: string;
  private balance: Money;
  private version: number;
  private readonly createdAt: Date;
  private updatedAt: Date;

  private constructor(props: WalletProps) {
    this.id = props.id;
    this.playerId = props.playerId;
    this.currency = props.currency;
    this.balance = props.balance;
    this.version = props.version ?? 1;
    this.createdAt = props.createdAt ?? new Date();
    this.updatedAt = props.updatedAt ?? new Date();
  }

  public getId(): string {
    return this.id;
  }

  public getPlayerId(): string {
    return this.playerId;
  }

  public getCurrency(): string {
    return this.currency;
  }

  public getBalance(): Money {
    return this.balance;
  }

  public getVersion(): number {
    return this.version;
  }

  public getCreatedAt(): Date {
    return this.createdAt;
  }

  public getUpdatedAt(): Date {
    return this.updatedAt;
  }

  public static create(props: WalletProps): Wallet { 
    if (!props.playerId || props.playerId.trim() === '') { //confere se o nome nao veio em branco
      throw new Error('Wallet playerId cannot be empty.');
    }

    if (props.balance.getCurrency() !== props.currency) { //confere se o dinheiro balance é igual ao currency
      throw new Error('Initial balance currency must match wallet currency.');
    }

    return new Wallet(props); //chama o construtor para montar o cofre com a primeira versao
  }

  public static rehydrate(props: WalletProps): Wallet {
    return new Wallet(props);
  }

  public credit(amount: Money, transactionId: string, ledgerEntryId: string): WalletLedgerEntry {
    if (amount.getCurrency() !== this.currency) { //confere a moeda "BRL"
      throw new Error(`Currency mismatch: wallet is ${this.currency}, got ${amount.getCurrency()}.`);
    }

    const balanceBefore = this.balance; //salva quanto tinha antes
    const balanceAfter = this.balance.add(amount); //salva quanto tem depois

    this.balance = balanceAfter; //atualiza o saldo
    this.version += 1; //atualiza a versao
    this.updatedAt = new Date(); //coloca a data da nova atualizacao da carteira

    return WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.CREDIT,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: this.updatedAt,
    });
  }

  public debit(amount: Money, transactionId: string, ledgerEntryId: string): WalletLedgerEntry {
    if (amount.getCurrency() !== this.currency) {
      throw new Error(`Currency mismatch: wallet is ${this.currency}, got ${amount.getCurrency()}.`);
    }

    if (!this.balance.isGreaterThanOrEqual(amount)) { //confere se saldo e menor que aposta
      throw new Error('Insufficient funds.');
    }

    const balanceBefore = this.balance;
    const balanceAfter = this.balance.subtract(amount);

    this.balance = balanceAfter;
    this.version += 1;
    this.updatedAt = new Date();

    return WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.DEBIT,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: this.updatedAt,
    });
  }
}