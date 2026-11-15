// Commodity exchange matching, run once per turn. A sell order fills only
// against buyers bidding at or above its limit price. Goods on an open sell
// order stay in the seller's inventory, reserved, until the order fills,
// is cancelled or expires; the seller is paid only for the quantity filled.
import type { Order, Book } from "./types";

export function matchSellOrder(order: Order, book: Book) {
  let filled = 0, proceeds = 0;
  for (const bid of book.bids.filter((b) => b.price >= order.limitPrice).sort((a, b) => b.price - a.price)) {
    const qty = Math.min(bid.quantity, order.quantity - filled);
    filled += qty; proceeds += qty * bid.price;
    if (filled >= order.quantity) break;
  }
  order.filled += filled;
  return { filled, proceeds };
}
