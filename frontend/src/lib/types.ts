/** Shapes returned by the API. Money fields are integer minor units. */

export type TeamRole = "owner" | "member";
export type SplitMode = "total" | "items";
export type ExpenseSource = "manual" | "receipt";

export interface User {
  id: string;
  email: string;
  display_name: string;
  /** Raw from the server; read it through parseAppearance (lib/glass.ts). */
  appearance?: unknown;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
}

export interface Member {
  user_id: string;
  display_name: string;
  email: string;
  role: TeamRole;
  default_weight: string;
}

export interface TeamSummary {
  id: string;
  name: string;
  currency: string;
  created_at: string;
  member_count: number;
  my_balance: number;
}

export interface TeamDetail {
  id: string;
  name: string;
  currency: string;
  created_at: string;
  members: Member[];
  my_role: TeamRole;
}

export interface Category {
  id: string;
  name: string;
  emoji: string;
  color: string;
  is_archived: boolean;
}

export interface Share {
  user_id: string;
  amount: number;
  weight: string | null;
}

export interface ExpenseItem {
  id: string;
  name: string;
  quantity: string;
  unit_price: number;
  total: number;
  category_id: string | null;
  shares: Share[];
  product_id: string | null;
  on_sale: boolean;
  regular_unit_price: number | null;
}

export interface Expense {
  id: string;
  team_id: string;
  title: string;
  note: string;
  currency: string;
  total: number;
  spent_at: string;
  payer_id: string;
  category_id: string | null;
  shop_id: string | null;
  split_mode: SplitMode;
  source: ExpenseSource;
  receipt_id: string | null;
  created_at: string;
  shares: Share[];
  items: ExpenseItem[];
  /** Only on a save: receipt prices that differ from a shop's saved price. */
  price_changes: PriceChange[];
}

export interface ExpenseList {
  items: Expense[];
  total_count: number;
}

export interface DailySpending {
  date: string;
  total: number;
  expense_count: number;
}

export interface Spending {
  currency: string;
  days: DailySpending[];
}

export interface PlannedItem {
  name: string;
  total: number | null;
}

export interface PlannedExpense {
  id: string;
  team_id: string;
  title: string;
  note: string;
  category_id: string | null;
  items: PlannedItem[];
  created_at: string;
}

export interface Balance {
  user_id: string;
  display_name: string;
  net: number;
}

export interface Transfer {
  from_user_id: string;
  to_user_id: string;
  amount: number;
}

export interface Balances {
  currency: string;
  balances: Balance[];
  transfers: Transfer[];
  total_spend: number;
}

export interface CategoryTotal {
  category_id: string | null;
  name: string;
  emoji: string;
  total: number;
}

export interface Settlement {
  id: string;
  from_user_id: string;
  to_user_id: string;
  amount: number;
  currency: string;
  note: string;
  settled_at: string;
  created_at: string;
}

export interface Invite {
  id: string;
  code: string;
  team_id: string;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  revoked: boolean;
}

export interface InvitePreview {
  team_name: string;
  member_count: number;
  currency: string;
}

export interface ParsedReceiptItem {
  name: string;
  quantity: string | null;
  unit_price: number | null;
  total: number;
  /** A readable name for a new product, written by the model. */
  product_name: string | null;
  product_id: string | null;
  /** receipt: this shop printed the line so before; model: recognised; name: same name. */
  product_match: "receipt" | "model" | "name" | null;
  on_sale: boolean;
  regular_unit_price: number | null;
}

export interface ShopMatch {
  shop_id: string | null;
  matched_by: "receipt" | "model" | null;
  /** What to call it, when it is a new shop. */
  name: string | null;
  address: string | null;
}

export interface ReceiptScan {
  merchant: string | null;
  shop: ShopMatch;
  purchased_at: string | null;
  currency: string | null;
  items: ParsedReceiptItem[];
  parsed_total: number | null;
  items_total: number;
  notes: string | null;
}

export interface ServerConfig {
  receipt_scanning: boolean;
  default_currency: string;
  max_receipt_images: number;
  max_upload_mb: number;
  /** VAPID key to subscribe to push with; absent on servers without push. */
  push_public_key?: string;
}

export type NotificationKind = "expense_created";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  created_at: string;
  read: boolean;
  team_id: string;
  team_name: string;
  actor_id: string | null;
  actor_name: string | null;
  expense_id: string | null;
  /** Snapshot of the expense as it was added. */
  title: string;
  total: number;
  currency: string;
  /** The reader's part of the total; 0 when they were not in on it. */
  share: number;
}

export interface NotificationList {
  items: AppNotification[];
  unread_count: number;
}

/* ------------------------------------------------------- shops and goods */

export interface Shop {
  id: string;
  name: string;
  address: string;
  /** Other names receipts print for it. */
  aliases: string[];
  product_count: number;
  last_visit: string | null;
}

/** One product at one shop. Prices are per unit (a piece, or a kilogram). */
export interface ShopPrice {
  shop_id: string;
  shop_name: string;
  /** Today's price there: a running sale, else the regular price. */
  price: number | null;
  regular_price: number | null;
  regular_on: string | null;
  sale_price: number | null;
  sale_on: string | null;
  sale_until: string | null;
  /** A sale is running today. */
  on_sale: boolean;
  last_paid: number | null;
  last_paid_on: string | null;
  last_paid_on_sale: boolean;
}

/** A receipt price that differs from the one saved for that shop. */
export interface PriceChange {
  product_id: string;
  product_name: string;
  shop_id: string;
  shop_name: string;
  observed_on: string;
  price: number;
  on_sale: boolean;
  regular_price: number | null;
  saved_price: number | null;
  saved_on_sale: boolean;
}

export interface PricePoint {
  expense_id: string;
  shop_id: string | null;
  shop_name: string | null;
  spent_at: string;
  price: number;
  quantity: string;
  on_sale: boolean;
}

export interface Product {
  id: string;
  name: string;
  /** Cheapest first; shops without a current price last. */
  prices: ShopPrice[];
  best_price: number | null;
  best_shop_id: string | null;
  last_bought_on: string | null;
  purchase_count: number;
  pending: PriceChange[];
}

export interface ProductDetail extends Product {
  history: PricePoint[];
  aliases: { shop_id: string; shop_name: string; name: string }[];
}

export interface ProductList {
  items: Product[];
  total_count: number;
}

export type PriceDecision = "regular" | "sale" | "keep";
export type ProductFilter = "all" | "compared" | "sale" | "changed";
export type ProductSort = "recent" | "name" | "spread";

/** Someone's answer to "this receipt has a new price -- update it?". */
export interface PriceAnswer {
  change: PriceChange;
  decision: PriceDecision;
  saleUntil?: string | null;
}

/** Tracked purchases against each good's usual price at the time. */
export interface Savings {
  currency: string;
  /** Sum of purchases that came in under the usual price. */
  saved: number;
  /** Sum of purchases that came in over it, as a positive amount. */
  extra: number;
  /** The part of `saved` from discounted lines. */
  on_sale: number;
  compared: number;
  purchases: number;
  /** Net saved per purchase date, shaped like spending so the same charts draw it. */
  days: DailySpending[];
  best: { product_id: string; name: string; saved: number }[];
}

/** One good read off a price screenshot; nothing is saved until imported. */
export interface ScannedPrice {
  name: string;
  product_name: string | null;
  product_id: string | null;
  product_match: "receipt" | "model" | "name" | null;
  /** Per piece or per kilogram; null when the model could not read it. */
  price: number | null;
  /** A crossed-out or old price shown beside it. */
  regular_price: number | null;
  sale_until: string | null;
}

export interface PriceScan {
  shop: ShopMatch;
  currency: string;
  items: ScannedPrice[];
  notes: string | null;
}

export interface ListedPrice {
  name: string;
  product_id: string | null;
  product_name: string | null;
  price: number;
  regular_price: number | null;
  sale_until: string | null;
}
