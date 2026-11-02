import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { UnitOfWorkRunner } from '../application/ports';
import { WageringService } from '../application/wagering.service';
import { TransactionType } from '../domain/wager-transaction';

export interface SqsPublisherPort {
  publish(eventType: string, aggregateId: string, payload: Record<string, unknown>): Promise<void>;
}

export class AwsSqsPublisher implements SqsPublisherPort {
  constructor(
    private readonly sqsClient: SQSClient,
    private readonly queueUrl: string,
  ) {}

  public async publish(
    eventType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const isFifo = this.queueUrl.endsWith('.fifo');
    await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ eventType, aggregateId, payload }),
        ...(isFifo
          ? {
              MessageGroupId: aggregateId,
              MessageDeduplicationId: String(payload.transactionId ?? Date.now()),
            }
          : {}),
      }),
    );
  }
}

export class OutboxRelayWorker {
  constructor(
    private readonly uowRunner: UnitOfWorkRunner,
    private readonly publisher: SqsPublisherPort,
  ) {}

  public async processPendingBatch(batchSize = 20): Promise<number> {
    return this.uowRunner.runInTransaction(async (uow) => {
      const pending = await uow.findPendingOutboxMessages(batchSize);
      let publishedCount = 0;

      for (const msg of pending) {
        try {
          await this.publisher.publish(
            msg.getEventType(),
            msg.getAggregateId(),
            msg.getPayload(),
          );
          msg.markPublished();
          await uow.saveOutboxMessage(msg);
          publishedCount += 1;
        } catch {
          msg.recordFailedAttempt();
          await uow.saveOutboxMessage(msg);
        }
      }

      return publishedCount;
    });
  }
}

export class SqsInboundConsumer {
  constructor(
    private readonly sqsClient: SQSClient,
    private readonly inboundQueueUrl: string,
    private readonly wageringService: WageringService,
  ) {}

  public async pollOnce(): Promise<number> {
    const res = await this.sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: this.inboundQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );

    const messages = res.Messages ?? [];
    let processed = 0;

    for (const msg of messages) {
      if (!msg.Body || !msg.MessageId || !msg.ReceiptHandle) continue;
      const body = JSON.parse(msg.Body) as Record<string, any>;

      await this.wageringService.processTransaction({
        transactionId: body.transactionId ?? body.id,
        walletId: String(body.walletId),
        type: body.type as TransactionType,
        amount: String(body.amount ?? body.money?.amount),
        currency: String(body.currency ?? body.money?.currency),
        referenceTransactionId: body.referenceTransactionId ?? null,
        idempotencyKey: body.idempotencyKey ?? msg.MessageId,
        inboxMessageId: msg.MessageId,
        inboxSource: 'SQS_FIFO',
      });

      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: this.inboundQueueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        }),
      );
      processed += 1;
    }

    return processed;
  }
}

export async function ensureSqsQueues(sqs: SQSClient): Promise<{
  inboundUrl: string;
  outboundUrl: string;
}> {
  const inbound = await sqs.send(
    new CreateQueueCommand({
      QueueName: 'wagering-inbound.fifo',
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
    }),
  );
  const outbound = await sqs.send(
    new CreateQueueCommand({
      QueueName: 'wagering-events.fifo',
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
    }),
  );
  return {
    inboundUrl: inbound.QueueUrl ?? '',
    outboundUrl: outbound.QueueUrl ?? '',
  };
}