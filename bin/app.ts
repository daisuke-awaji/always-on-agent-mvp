import { App } from 'aws-cdk-lib';
import { AlwaysOnAgentStack } from '../lib/always-on-agent-stack.js';

const app = new App();
// cdk.json の値は JSON の型のまま、`-c key=value` の値は文字列で届く
const ctx = (key: string): unknown => app.node.tryGetContext(key);
const ctxString = (key: string): string | undefined => {
  const v = ctx(key);
  return typeof v === 'string' && v !== '' ? v : undefined;
};
const destroyOnRemoval = ctx('destroyOnRemoval');

new AlwaysOnAgentStack(app, 'AlwaysOnAgentMvp', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  modelId: ctxString('modelId') ?? 'jp.anthropic.claude-sonnet-4-6',
  notifyEmail: ctxString('notifyEmail'),
  // 未指定なら true（cdk.json の既定と同じ）。false にするには cdk.json か `-c destroyOnRemoval=false`
  destroyOnRemoval: destroyOnRemoval === undefined || destroyOnRemoval === null || destroyOnRemoval === true || destroyOnRemoval === 'true',
});
