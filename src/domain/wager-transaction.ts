import { Money } from './money';

export enum TransactionType {
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum TransactionStatus {
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
}

export interface WagerTransactionProps {
  id: string;
  walletId: string;
  type: TransactionType;
  money: Money;
  referenceTransactionId?: string | null;
  idempotencyKey?: string | null;
  status: TransactionStatus;
  rejectionReason?: string | null;
  createdAt?: Date;
  processedAt?: Date | null;
}

export class WagerTransaction {
  private readonly id: string;
  private readonly walletId: string;
  private readonly type: TransactionType;
  private readonly money: Money;
  private readonly referenceTransactionId: string | null;
  private readonly idempotencyKey: string | null;
  private status: TransactionStatus;
  private rejectionReason: string | null;
  private readonly createdAt: Date;
  private processedAt: Date | null;

  private constructor(props: WagerTransactionProps) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.type = props.type;
    this.money = props.money;
    this.referenceTransactionId = props.referenceTransactionId ?? null;
    this.idempotencyKey = props.idempotencyKey ?? null;
    this.status = props.status;
    this.rejectionReason = props.rejectionReason ?? null;
    this.createdAt = props.createdAt ?? new Date();
    this.processedAt = props.processedAt ?? null;
  }

  public getId(): string {
    return this.id;
  }

  public getWalletId(): string {
    return this.walletId;
  }

  public getType(): TransactionType {
    return this.type;
  }

  public getMoney(): Money {
    return this.money;
  }

  public getReferenceTransactionId(): string | null {
    return this.referenceTransactionId;
  }

  public getIdempotencyKey(): string | null {
    return this.idempotencyKey;
  }

  public getStatus(): TransactionStatus {
    return this.status;
  }

  public getRejectionReason(): string | null {
    return this.rejectionReason;
  }

  public getCreatedAt(): Date {
    return this.createdAt;
  }

  public getProcessedAt(): Date | null {
    return this.processedAt;
  }

  public static createProcessed(
    props: Omit<WagerTransactionProps, 'status' | 'rejectionReason' | 'processedAt'>,
  ): WagerTransaction {
    const now = new Date();
    return new WagerTransaction({
      ...props,
      status: TransactionStatus.PROCESSED,
      rejectionReason: null,
      createdAt: props.createdAt ?? now,
      processedAt: now,
    });
  }

  public static createRejected(
    props: Omit<WagerTransactionProps, 'status' | 'processedAt'> & { rejectionReason: string },
  ): WagerTransaction {
    const now = new Date();
    return new WagerTransaction({
      ...props,
      status: TransactionStatus.REJECTED,
      rejectionReason: props.rejectionReason,
      createdAt: props.createdAt ?? now,
      processedAt: now,
    });
  }

  public static createPendingReference(
    props: Omit<WagerTransactionProps, 'status' | 'rejectionReason' | 'processedAt'>,
  ): WagerTransaction {
    return new WagerTransaction({
      ...props,
      status: TransactionStatus.PENDING_REFERENCE,
      rejectionReason: null,
      createdAt: props.createdAt ?? new Date(),
      processedAt: null,
    });
  }

  public static rehydrate(props: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction(props);
  }

  public markProcessed(): void {
    if (this.status !== TransactionStatus.PENDING_REFERENCE) {
      throw new Error(`Cannot mark transaction as PROCESSED from status ${this.status}.`);
    }
    this.status = TransactionStatus.PROCESSED;
    this.rejectionReason = null;
    this.processedAt = new Date();
  }

  public markRejected(reason: string): void {
    if (this.status !== TransactionStatus.PENDING_REFERENCE) {
      throw new Error(`Cannot mark transaction as REJECTED from status ${this.status}.`);
    }
    this.status = TransactionStatus.REJECTED;
    this.rejectionReason = reason;
    this.processedAt = new Date();
  }
}