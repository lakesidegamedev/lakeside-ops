// Orders expire three turns after they are placed. Unfilled goods return to
// unreserved inventory; nothing is charged for an expired order.
import type { Order, Inventory } from "./types";

export const ORDER_LIFETIME_TURNS = 3;

export function expireOrder(order: Order, inventory: Inventory, turn: number) {
  if (turn < order.placedTurn + ORDER_LIFETIME_TURNS) return false;
  inventory.reserved[order.commodity] -= order.quantity - order.filled;
  order.status = "expired";
  return true;
}
