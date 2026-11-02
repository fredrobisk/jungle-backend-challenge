export enum InboxStatus {
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

export interface InboxMessageProps {
  id: string;
  messageId: string;
  source: string;
  payload: Record<string, unknown>;
  status: InboxStatus;
  processedAt?: Date;
}

export class InboxMessage {
  private readonly id: string;
  private readonly messageId: string;
  private readonly source: string;
  private readonly payload: Record<string, unknown>;
  private readonly status: InboxStatus;
  private readonly processedAt: Date;

  private constructor(props: InboxMessageProps) {
    this.id = props.id;
    this.messageId = props.messageId;
    this.source = props.source;
    this.payload = props.payload;
    this.status = props.status;
    this.processedAt = props.processedAt ?? new Date();
  }

  public getId(): string {
    return this.id;
  }

  public getMessageId(): string {
    return this.messageId;
  }

  public getSource(): string {
    return this.source;
  }

  public getPayload(): Record<string, unknown> {
    return this.payload;
  }

  public getStatus(): InboxStatus {
    return this.status;
  }

  public getProcessedAt(): Date {
    return this.processedAt;
  }

  public static createProcessed(
    props: Omit<InboxMessageProps, 'status' | 'processedAt'>,
  ): InboxMessage {
    return new InboxMessage({
      ...props,
      status: InboxStatus.PROCESSED,
      processedAt: new Date(),
    });
  }

  public static rehydrate(props: InboxMessageProps): InboxMessage {
    return new InboxMessage(props);
  }
}

export enum OutboxStatus {
  PENDING = 'PENDING',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
}

export interface OutboxMessageProps {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  status?: OutboxStatus;
  attempts?: number;
  createdAt?: Date;
  publishedAt?: Date | null;
}

export class OutboxMessage {
  private readonly id: string;
  private readonly eventType: string;
  private readonly aggregateId: string;
  private readonly payload: Record<string, unknown>;
  private status: OutboxStatus;
  private attempts: number;
  private readonly createdAt: Date;
  private publishedAt: Date | null;

  private constructor(props: OutboxMessageProps) {
    this.id = props.id;
    this.eventType = props.eventType;
    this.aggregateId = props.aggregateId;
    this.payload = props.payload;
    this.status = props.status ?? OutboxStatus.PENDING;
    this.attempts = props.attempts ?? 0;
    this.createdAt = props.createdAt ?? new Date();
    this.publishedAt = props.publishedAt ?? null;
  }

  public getId(): string {
    return this.id;
  }

  public getEventType(): string {
    return this.eventType;
  }

  public getAggregateId(): string {
    return this.aggregateId;
  }

  public getPayload(): Record<string, unknown> {
    return this.payload;
  }

  public getStatus(): OutboxStatus {
    return this.status;
  }

  public getAttempts(): number {
    return this.attempts;
  }

  public getCreatedAt(): Date {
    return this.createdAt;
  }

  public getPublishedAt(): Date | null {
    return this.publishedAt;
  }

  public static createPending(
    props: Omit<OutboxMessageProps, 'status' | 'attempts' | 'publishedAt'>,
  ): OutboxMessage {
    return new OutboxMessage({
      ...props,
      status: OutboxStatus.PENDING,
      attempts: 0,
      publishedAt: null,
    });
  }

  public static rehydrate(props: OutboxMessageProps): OutboxMessage {
    return new OutboxMessage(props);
  }

  public markPublished(): void {
    this.status = OutboxStatus.PUBLISHED;
    this.publishedAt = new Date();
  }

  public recordFailedAttempt(): void {
    this.attempts += 1;
    this.status = OutboxStatus.FAILED;
  }
}