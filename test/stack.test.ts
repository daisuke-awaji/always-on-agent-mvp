import { execFileSync } from 'node:child_process';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AlwaysOnAgentStack } from '../lib/always-on-agent-stack.js';

let template: Template;

beforeAll(() => {
  execFileSync('node', ['scripts/build-agent.mjs'], { stdio: 'ignore' });
  const app = new App();
  const stack = new AlwaysOnAgentStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
    modelId: 'jp.anthropic.claude-sonnet-4-6',
    destroyOnRemoval: false,
  });
  template = Template.fromStack(stack);
}, 120_000);

describe('AlwaysOnAgentStack', () => {
  it('AgentCore Runtime を Node 22 の直接コードデプロイで作る', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeArtifact: { CodeConfiguration: { Runtime: 'NODE_22', EntryPoint: ['main.js'] } },
      EnvironmentVariables: Match.objectLike({ MODEL_ID: 'jp.anthropic.claude-sonnet-4-6' }),
      LifecycleConfiguration: { IdleRuntimeSessionTimeout: 300, MaxLifetime: 3600 },
    });
  });

  it('wake 信号は FIFO キュー。可視性タイムアウトは worker のタイムアウトより長い', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      FifoQueue: true,
      ContentBasedDeduplication: false,
      VisibilityTimeout: 960,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 900,
      Environment: { Variables: Match.objectLike({ AGENT_RUNTIME_ARN: Match.anyValue() }) },
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { FunctionResponseTypes: ['ReportBatchItemFailures'] });
  });

  it('テーブルは TTL と PITR を有効にし、RETAIN 指定なら残す', () => {
    template.resourcePropertiesCountIs(
      'AWS::DynamoDB::GlobalTable',
      { TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } },
      2,
    );
    template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
  });

  it('API はすべて IAM 認証', () => {
    const methods = template.findResources('AWS::ApiGateway::Method');
    const nonOptions = (Object.values(methods) as { Properties: { HttpMethod: string; AuthorizationType: string } }[]).filter(
      (m) => m.Properties.HttpMethod !== 'OPTIONS',
    );
    expect(nonOptions).toHaveLength(3);
    for (const m of nonOptions) expect(m.Properties.AuthorizationType).toBe('AWS_IAM');
  });

  it('Runtime のロールは memory/ と sessions/ だけ、Messages は PutItem だけ', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p).includes('AgentRuntimeExecutionRole'),
    );
    const doc = JSON.stringify(policies);
    expect(doc).toContain('/memory/*');
    expect(doc).toContain('/sessions/*');
    expect(doc).toContain('"dynamodb:PutItem"');
    expect(doc).not.toContain('dynamodb:Scan');
    expect(doc).toContain('inference-profile/jp.anthropic.claude-sonnet-4-6');
  });
});
