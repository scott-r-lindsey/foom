/**
 * smol-toml 1.9.1 supplies a CommonJS runtime export but labels its shared .d.ts
 * as ESM. Declare only the synchronous boundary we use, returning unknown for
 * runtime validation. This avoids changing this project's Node16 compiler mode.
 */
declare module "smol-toml" {
  export function parse(
    source: string,
    options: { maxDepth: number; unsafeKeyBehaviour: "throw" },
  ): unknown;
}
