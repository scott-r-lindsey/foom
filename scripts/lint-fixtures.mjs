// Each pair isolates a safety behavior or a nontrivial default/TypeScript alias.
// Invalid programs are strings: they are lint inputs, never executed or imported.
export const lintFixtures = [
  ["typescript/no-floating-promises", "Promise.resolve(1);", "void Promise.resolve(1);"],
  [
    "typescript/await-thenable",
    "export async function f() { await 1; }",
    "export async function f() { await Promise.resolve(1); }",
  ],
  [
    "typescript/no-misused-promises",
    "if (Promise.resolve(true)) { console.log('x'); }",
    "export async function f() { if (await Promise.resolve(true)) { console.log('x'); } }",
  ],
  [
    "typescript/no-unsafe-assignment",
    "declare const input: any; export const value: string = input;",
    "declare const input: unknown; export const value: unknown = input;",
  ],
  [
    "typescript/no-unsafe-call",
    "declare const input: any; input();",
    "declare const input: () => void; input();",
  ],
  [
    "typescript/no-unsafe-member-access",
    "declare const input: any; export const value = input.key;",
    "declare const input: {key: string}; export const value = input.key;",
  ],
  [
    "typescript/no-unsafe-argument",
    "declare const input: any; declare function f(x: string): void; f(input);",
    "declare const input: string; declare function f(x: string): void; f(input);",
  ],
  [
    "typescript/no-unsafe-return",
    "declare const input: any; export function f(): string { return input; }",
    "declare const input: string; export function f(): string { return input; }",
  ],
  [
    "typescript/no-unsafe-unary-minus",
    "declare const input: string; export const value = -input;",
    "declare const input: number; export const value = -input;",
  ],
  [
    "typescript/no-unsafe-enum-assignment",
    "enum Fruit {Apple = 1} export const fruit: Fruit = 1;",
    "enum Fruit {Apple = 1} export const fruit: Fruit = Fruit.Apple;",
  ],
  [
    "typescript/no-unsafe-enum-comparison",
    "enum Fruit {Apple = 1} declare const fruit: Fruit; export const same = fruit === 1;",
    "enum Fruit {Apple = 1} declare const fruit: Fruit; export const same = fruit === Fruit.Apple;",
  ],
  [
    "typescript/no-generated-empty-object-type",
    "export type Empty = Pick<{key: string}, never>;",
    "export type Present = Pick<{key: string}, 'key'>;",
  ],
  [
    "typescript/no-unnecessary-condition",
    "declare const value: string; if(value != null) { console.log(value); }",
    "declare const value: string | undefined; if(value != null) { console.log(value); }",
  ],
  [
    "typescript/no-unnecessary-type-assertion",
    "declare const value: string; export const result = value as string;",
    "declare const value: unknown; export const result = value as string;",
  ],
  [
    "typescript/no-unnecessary-type-parameters",
    "export function f<T extends string>(value: T): void { console.log(value); }",
    "export function f<T>(value: T): T { return value; }",
  ],
  [
    "typescript/no-unnecessary-type-conversion",
    "declare const value: string; export const result = String(value);",
    "declare const value: number; export const result = String(value);",
  ],
  [
    "typescript/no-redundant-type-constituents",
    "export type Value = string | never;",
    "export type Value = string | number;",
  ],
  [
    "typescript/no-duplicate-type-constituents",
    "export type Value = string | string;",
    "export type Value = string | number;",
  ],
  [
    "typescript/no-confusing-void-expression",
    "declare function f(): void; export const result = f();",
    "declare function f(): void; f();",
  ],
  [
    "typescript/no-meaningless-void-operator",
    "declare function f(): void; void f();",
    "declare function f(): Promise<void>; void f();",
  ],
  [
    "typescript/no-array-delete",
    "declare const values: number[]; delete values[0];",
    "declare const values: number[]; values.splice(0, 1);",
  ],
  [
    "typescript/no-for-in-array",
    "declare const values: number[]; for (const key in values) { console.log(key); }",
    "declare const values: number[]; for (const value of values) { console.log(value); }",
  ],
  [
    "typescript/no-base-to-string",
    "export const value = String({});",
    "export const value = String(1);",
  ],
  [
    "typescript/no-misused-spread",
    "export const value = {...Promise.resolve(1)};",
    "export const value = {...{key: 1}};",
  ],
  [
    "typescript/no-deprecated",
    "/** @deprecated use replacement */ declare function f(): void; f();",
    "declare function f(): void; f();",
  ],
  [
    "typescript/restrict-plus-operands",
    "export const value = 1 + 'x';",
    "export const value = 1 + 2;",
  ],
  [
    "typescript/restrict-template-expressions",
    "declare const input: number; export const value = `${input}`;",
    "declare const input: string; export const value = `${input}`;",
  ],
  ["typescript/only-throw-error", "throw 'failed';", "throw new Error('failed');"],
  [
    "typescript/prefer-promise-reject-errors",
    "Promise.reject('failed');",
    "Promise.reject(new Error('failed'));",
  ],
  [
    "typescript/require-await",
    "export async function f() { return 1; }",
    "export async function f() { return await Promise.resolve(1); }",
  ],
  [
    "typescript/return-await",
    "export async function f() { try { return Promise.reject(new Error('failed')); } catch { return 1; } }",
    "export async function f() { try { return await Promise.reject(new Error('failed')); } catch { return 1; } }",
  ],
  [
    "typescript/use-unknown-in-catch-callback-variable",
    "Promise.reject(new Error('x')).catch(error => console.log(error));",
    "Promise.reject(new Error('x')).catch((error: unknown) => console.log(error));",
  ],
  [
    "typescript/unbound-method",
    "declare const instance: {method(): void}; export const method = instance.method;",
    "declare const instance: {method(this: void): void}; export const method = instance.method;",
  ],
  ["typescript/no-explicit-any", "export type Value = any;", "export type Value = unknown;"],
  [
    "typescript/no-non-null-assertion",
    "declare const value: string | null; export const result = value!;",
    "declare const value: string | null; export const result = value ?? '';",
  ],
  [
    "typescript/consistent-type-imports",
    "import { Token } from './types'; export const value: Token = {key: 'x'};",
    "import type { Token } from './types'; export const value: Token = {key: 'x'};",
  ],
  [
    "eslint/no-unused-vars",
    "const _unused = 1;",
    "export function f(_argument: number) { return 1; }",
  ],
  [
    "eslint/no-unused-vars",
    "try { throw new Error('x'); } catch (error) {}",
    "try { throw new Error('x'); } catch {}",
  ],
  [
    "eslint/no-unused-vars",
    "import type { Token } from './types';",
    "import type { Token } from './types'; export type Value = Token;",
  ],
  [
    "eslint/no-unused-expressions",
    "declare const value: boolean; value && console.log('x');",
    "declare const value: boolean; if(value) console.log('x');",
  ],
  [
    "eslint/no-array-constructor",
    "export const value = new Array();",
    "export const value = new Array(5);",
  ],
  [
    "eslint/no-useless-constructor",
    "export class Value { constructor() {} }",
    "export class Value { constructor(public key: string) {} }",
  ],
  [
    "eslint/preserve-caught-error",
    "try { throw new Error('x'); } catch(error) { throw new Error('failed'); }",
    "try { throw new Error('x'); } catch(error) { throw new Error('failed', {cause: error}); }",
  ],
  [
    "eslint/no-unsafe-optional-chaining",
    "declare const value: {items: string[]} | undefined; export const first = (value?.items)[0];",
    "declare const value: {items: string[]} | undefined; export const first = value?.items[0];",
  ],
  [
    "eslint/no-extra-boolean-cast",
    "declare const value: unknown; if(Boolean(value)) console.log('x');",
    "declare const value: unknown; export const result = Boolean(value);",
  ],
  [
    "eslint/no-constant-binary-expression",
    "export const value = 1 || 2;",
    "declare const value: number; export const result = value || 2;",
  ],
  ["eslint/no-control-regex", "export const pattern = /\\x00/;", "export const pattern = /x/;"],
  [
    "eslint/no-loss-of-precision",
    "export const value = 9007199254740993;",
    "export const value = 9007199254740993n;",
  ],
  ["typescript/no-implied-eval", "setTimeout('doWork()', 1);", "setTimeout(() => {}, 1);"],
  [
    "typescript/no-mixed-enums",
    "export enum Value { A = 1, B = 'x' }",
    "export enum Value { A = 1, B = 2 }",
  ],
  [
    "typescript/no-unnecessary-boolean-literal-compare",
    "declare const value: boolean; if(value === true) console.log(value);",
    "declare const value: boolean | undefined; if(value === true) console.log(value);",
  ],
  [
    "typescript/no-unnecessary-template-expression",
    "declare const value: string; export const result = `${value}`;",
    "declare const value: number; export const result = `${value}`;",
  ],
  [
    "typescript/no-unnecessary-type-arguments",
    "declare function f<T = string>(): T; export const value = f<string>();",
    "declare function f<T = string>(): T; export const value = f<number>();",
  ],
  [
    "typescript/no-useless-default-assignment",
    "declare const value: {key: string}; export const {key = 'x'} = value;",
    "declare const value: {key?: string}; export const {key = 'x'} = value;",
  ],
  [
    "typescript/prefer-reduce-type-parameter",
    "declare const values: string[]; export const result = values.reduce((acc, x) => [...acc, x], [] as string[]);",
    "declare const values: string[]; export const result = values.reduce<string[]>((acc, x) => [...acc, x], []);",
  ],
  [
    "typescript/prefer-return-this-type",
    "export class Value { method(): Value { return this; } }",
    "export class Value { method(): this { return this; } }",
  ],
  [
    "typescript/related-getter-setter-pairs",
    "export class Value { get value(): string { return 'x'; } set value(input: number) { console.log(input); } }",
    "export class Value { get value(): string { return 'x'; } set value(input: string | number) { console.log(input); } }",
  ],
];
