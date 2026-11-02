import { Money } from './money';

export enum LedgerDirection { //seção 6.4 "Directions: DEBIT e CREDIT"
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

export interface WalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export class WalletLedgerEntry {
  private readonly id: string;
  private readonly walletId: string;
  private readonly transactionId: string;
  private readonly direction: LedgerDirection;
  private readonly money: Money;
  private readonly balanceBefore: Money;
  private readonly balanceAfter: Money;
  private readonly createdAt: Date;

  private constructor(props: WalletLedgerEntryProps) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.direction = props.direction;
    this.money = props.money;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.createdAt = props.createdAt ?? new Date(); //pega o horario do servidor
  }// return invisivel

  public getId(): string {
    return this.id;
  }

  public getWalletId(): string {
    return this.walletId;
  }

  public getTransactionId(): string {
    return this.transactionId;
  }

  public getDirection(): LedgerDirection {
    return this.direction;
  }

  public getMoney(): Money {
    return this.money;
  }

  public getBalanceBefore(): Money {
    return this.balanceBefore;
  }

  public getBalanceAfter(): Money {
    return this.balanceAfter;
  }

  public getCreatedAt(): Date {
    return this.createdAt;
  }

  public static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    if (props.money.getCents() <= 0n) {
      throw new Error('Ledger entry amount must be strictly positive.');
    }

    if (
      props.money.getCurrency() !== props.balanceBefore.getCurrency() ||
      props.money.getCurrency() !== props.balanceAfter.getCurrency()
    ) {
      throw new Error('Ledger entry currencies must match.');
    }

    return new WalletLedgerEntry(props);// devolve com o registro criado para wallet
  }

  public static rehydrate(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(props);
  }
}