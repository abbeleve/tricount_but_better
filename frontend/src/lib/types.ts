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
  split_mode: SplitMode;
  source: ExpenseSource;
  receipt_id: string | null;
  created_at: string;
  shares: Share[];
  items: ExpenseItem[];
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
}

export interface ReceiptScan {
  merchant: string | null;
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
