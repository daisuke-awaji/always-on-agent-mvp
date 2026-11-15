import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface AlwaysOnAgentStackProps extends StackProps {
  /** Bedrock のモデル ID（推論プロファイル ID）。例: jp.anthropic.claude-sonnet-4-6 */
  modelId: string;
  /** 指定するとエージェントの送信をメールでも受け取れる（SNS の購読確認が必要） */
  notifyEmail?: string;
  /** true ならスタック削除時にデータも消す（サンプル用）。本番では false にする */
  destroyOnRemoval?: boolean;
}

/**
 * Always-on agent MVP
 *
 *   API Gateway (IAM) ─▶ Handler λ ─▶ Inbox (DynamoDB) ◀──────────┐
 *                                 └─▶ Wake (SQS FIFO, group=userId) │
 *                                          ▼                        │
 *                                     Worker λ ── lease / batch ────┘
 *                                          ▼ InvokeAgentRuntime
 *                                AgentCore Runtime (Node 22, Claude on Bedrock)
 *                                  ├─ S3: memory/<userId>/…, sessions/<userId>/…
 *                                  └─ send_message ─▶ Messages (DynamoDB) + SNS
 */
export class AlwaysOnAgentStack extends Stack {
  constructor(scope: Construct, id: string, props: AlwaysOnAgentStackProps) {
    super(scope, id, props);
    const removalPolicy = props.destroyOnRemoval ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    // ---------------- ストレージ ----------------
    // Memory と Session（記事: memory は worker より長生きする永続ストレージに置く）
    const stateBucket = new s3.Bucket(this, 'StateBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true, // エージェントがメモリを壊しても過去の版に戻せる
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy,
      autoDeleteObjects: props.destroyOnRemoval,
    });

    // Event inbox（イベント・重複排除・リースを 1 テーブルで管理）
    const inboxTable = new dynamodb.TableV2(this, 'InboxTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    // 送信済みメッセージ（MVP の send ツールの配信記録。次段階で Outbox を前段に置く）
    const messagesTable = new dynamodb.TableV2(this, 'MessagesTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    const notifyTopic = new sns.Topic(this, 'NotifyTopic', { displayName: 'Always-on agent' });
    if (props.notifyEmail) notifyTopic.addSubscription(new subs.EmailSubscription(props.notifyEmail));

    // ---------------- Wake 信号（SQS FIFO） ----------------
    const workerTimeout = Duration.minutes(15);
    const wakeDlq = new sqs.Queue(this, 'WakeDlq', {
      fifo: true,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const wakeQueue = new sqs.Queue(this, 'WakeQueue', {
      fifo: true,
      contentBasedDeduplication: false, // 重複排除 ID は eventId を明示的に渡す
      visibilityTimeout: Duration.minutes(16), // worker のタイムアウトより長く
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: wakeDlq, maxReceiveCount: 5 },
    });

    // ---------------- AgentCore Runtime ----------------
    const runtime = new agentcore.Runtime(this, 'AgentRuntime', {
      runtimeName: `aoa_${this.stackName.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 48),
      description: 'Always-on agent MVP (event-driven runs, S3 memory, send tool)',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: join(root, 'dist/agent'), // scripts/build-agent.mjs が esbuild で生成
        runtime: agentcore.AgentCoreRuntime.NODE_22,
        entrypoint: ['main.js'],
      }),
      environmentVariables: {
        MODEL_ID: props.modelId,
        STATE_BUCKET: stateBucket.bucketName,
        MESSAGES_TABLE: messagesTable.tableName,
        NOTIFY_TOPIC_ARN: notifyTopic.topicArn,
        NODE_OPTIONS: '--enable-source-maps',
      },
      // session の記録は S3 にあるので、microVM は短いアイドルで止めてよい
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: Duration.minutes(5),
        maxLifetime: Duration.hours(1),
      },
    });

    stateBucket.grantReadWrite(runtime, 'memory/*');
    stateBucket.grantReadWrite(runtime, 'sessions/*');
    messagesTable.grant(runtime, 'dynamodb:PutItem');
    notifyTopic.grantPublish(runtime);
    runtime.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          // 推論プロファイル（jp. / global. など）と、その振り分け先の基盤モデル
          `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${props.modelId}`,
          `arn:${this.partition}:bedrock:*::foundation-model/*`,
        ],
      }),
    );

    // ---------------- Lambda ----------------
    const commonFn: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      depsLockFilePath: join(root, 'package-lock.json'),
      projectRoot: root,
      // Lambda 組み込みの AWS SDK の版に依存しないよう、SDK も含めてバンドルする
      // （client-bedrock-agentcore は新しいクライアントのため特に重要）
      bundling: { minify: true, sourceMap: true, target: 'node22', externalModules: [] },
      loggingFormat: lambda.LoggingFormat.JSON,
    };

    const handlerFn = new nodejs.NodejsFunction(this, 'HandlerFn', {
      ...commonFn,
      entry: join(root, 'src/functions/handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(10), // 素早く ACK する
      environment: {
        INBOX_TABLE: inboxTable.tableName,
        MESSAGES_TABLE: messagesTable.tableName,
        WAKE_QUEUE_URL: wakeQueue.queueUrl,
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new logs.LogGroup(this, 'HandlerLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy }),
    });
    inboxTable.grantReadWriteData(handlerFn);
    messagesTable.grantReadData(handlerFn);
    wakeQueue.grantSendMessages(handlerFn);

    const workerFn = new nodejs.NodejsFunction(this, 'WorkerFn', {
      ...commonFn,
      entry: join(root, 'src/functions/worker.ts'),
      handler: 'handler',
      timeout: workerTimeout,
      environment: {
        INBOX_TABLE: inboxTable.tableName,
        MESSAGES_TABLE: messagesTable.tableName,
        WAKE_QUEUE_URL: wakeQueue.queueUrl,
        AGENT_RUNTIME_ARN: runtime.agentRuntimeArn,
        RUN_TIMEOUT_MS: String(12 * 60_000),
        LEASE_MS: String(16 * 60_000),
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new logs.LogGroup(this, 'WorkerLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy }),
    });
    inboxTable.grantReadWriteData(workerFn);
    messagesTable.grantReadData(workerFn);
    wakeQueue.grantSendMessages(workerFn); // 時間切れ時の再 wake
    runtime.grantInvokeRuntime(workerFn);
    workerFn.addEventSource(new SqsEventSource(wakeQueue, { batchSize: 10, reportBatchItemFailures: true }));

    // ---------------- API ----------------
    const api = new apigw.RestApi(this, 'Api', {
      description: 'Always-on agent event inbox',
      defaultMethodOptions: { authorizationType: apigw.AuthorizationType.IAM },
      deployOptions: { stageName: 'v1', throttlingRateLimit: 20, throttlingBurstLimit: 40 },
      endpointConfiguration: { types: [apigw.EndpointType.REGIONAL] },
    });
    const integration = new apigw.LambdaIntegration(handlerFn);
    const user = api.root.addResource('users').addResource('{userId}');
    const events = user.addResource('events');
    events.addMethod('POST', integration);
    events.addMethod('GET', integration);
    user.addResource('messages').addMethod('GET', integration);

    // DLQ に落ちた wake 信号の監視（通知先は運用に合わせて設定する）
    new cloudwatch.Alarm(this, 'WakeDlqAlarm', {
      metric: wakeDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Wake messages are failing repeatedly (inbox events may be stuck)',
    });

    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'AgentRuntimeArn', { value: runtime.agentRuntimeArn });
    new CfnOutput(this, 'StateBucketName', { value: stateBucket.bucketName });
    new CfnOutput(this, 'InboxTableName', { value: inboxTable.tableName });
    new CfnOutput(this, 'MessagesTableName', { value: messagesTable.tableName });
    new CfnOutput(this, 'NotifyTopicArn', { value: notifyTopic.topicArn });
  }
}
