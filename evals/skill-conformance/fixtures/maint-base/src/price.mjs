export function priceAfterDiscount(price, rate) {
  const discounted = price - price * rate;
  return discounted - discounted * rate;
}
