export declare class FieldURL {
  constructor(input: string, base?: string);
  readonly href: string;
  readonly pathname: string;
  readonly hash: string;
  readonly searchParams: { entries(): IterableIterator<[string, string]> };
  readonly origin: string;
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
}
