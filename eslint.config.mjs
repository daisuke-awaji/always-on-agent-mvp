// @ts-check
import eslint from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // web/ は自分の package.json と eslint.config.mjs を持つ（React 用の設定）
  globalIgnores(['node_modules/', 'dist/', 'cdk.out/', '.local-state/', 'coverage/', 'web/']),

  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 上限値などの数値をエラーメッセージやプロンプトに埋め込むのは安全なので許可する
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `const { pk: _pk, ...rest } = item` のように、キーを除くための分割代入は許可する
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },

  // scripts/*.mjs と設定ファイルは tsconfig の対象外なので、型情報を使うルールを外す
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['test/**/*.ts'],
    extends: [vitest.configs.recommended],
    rules: {
      // フェイクは async のインターフェースを同期的に実装するので await がなくてよい
      '@typescript-eslint/require-await': 'off',
      // 直前の操作で必ず存在する値の取り出しに使う。無ければその場でテストが落ちる
      '@typescript-eslint/no-non-null-assertion': 'off',
      // CDK の Template.has*/resourceCountIs はアサーションとして扱う
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'template.*'] }],
    },
  },

  // 書式は Prettier に任せる（最後に置いて、衝突するルールを無効化する）
  prettier,
);
