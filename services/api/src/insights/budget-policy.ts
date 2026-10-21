export class BudgetPolicyError extends Error {
  constructor(
    readonly code:
      | "budget_exceeded"
      | "budget_model_unpriced"
      | "budget_usage_unconfirmed"
      | "budget_reservation_not_found"
      | "model_call_conflict"
      | "model_call_invalid"
      | "model_call_not_owned",
    message: string,
  ) {
    super(message);
    this.name = "BudgetPolicyError";
  }
}
