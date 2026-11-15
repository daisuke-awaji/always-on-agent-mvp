import type { Route } from './route';

export type { Route };

export const PATTERNS: { route: Exclude<Route, 'overview'>; letter: string; name: string; tagline: string }[] = [
  { route: 'chat', letter: 'A', name: '会話', tagline: 'session を会話のスレッドとして見せる' },
  { route: 'inbox', letter: 'B', name: '通知箱', tagline: 'エージェントからの連絡を受信箱として見せる' },
  { route: 'console', letter: 'C', name: '運用', tagline: 'イベントと run の流れをそのまま見せる' },
];
