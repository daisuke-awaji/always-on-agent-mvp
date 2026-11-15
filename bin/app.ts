import { App } from 'aws-cdk-lib';
import { AlwaysOnAgentStack } from '../lib/always-on-agent-stack.js';

const app = new App();
const ctx = (key: string) => app.node.tryGetContext(key);

new AlwaysOnAgentStack(app, 'AlwaysOnAgentMvp', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  modelId: ctx('modelId') ?? 'jp.anthropic.claude-sonnet-4-6',
  notifyEmail: ctx('notifyEmail') || undefined,
  destroyOnRemoval: String(ctx('destroyOnRemoval') ?? 'true') === 'true',
});
