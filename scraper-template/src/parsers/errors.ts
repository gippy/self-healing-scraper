/** Thrown when a parser cannot read its input. Parsers never return partial or empty data instead. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}
