/** One scraped record. The parser fills what the page shows; leave out what it does not. */
export type Item = {
  id: string;
  title: string;
  category?: string;
  price?: { amount: number; currency: string };
  bids?: number;
  status?: string;
  /** ISO 8601. */
  endsAt?: string;
  url?: string;
};
