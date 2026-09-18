/** Internal native owner; not a public plugin SDK contract. */
declare const authority: Readonly<{
  mint(scope: object, authenticated: boolean): () => void;
  inherit(from: object | undefined, to: object): void;
  has(scope: object | undefined): boolean;
}>;
export = authority;
