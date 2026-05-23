export function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

export function absoluteCents(cents: number): number {
  return Math.abs(cents);
}
