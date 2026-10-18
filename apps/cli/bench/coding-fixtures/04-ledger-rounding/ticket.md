# Ticket: settlement splits lose or invent cents

Finance reports that month-end settlement totals drift by a cent or two. Splitting 100.00 three ways pays out 99.99, some weighted allocations pay out more than the source amount, and a few parsed amounts are a cent short (for example "0.29" is booked as 28 cents).

Repair src/ledger.cjs. Keep the exports and signatures:

- parseAmount(text): text is a decimal string with an optional leading "-", one or more digits, and optionally "." followed by one or two digits ("12", "12.3", "-0.05"). Returns integer minor units (cents). Anything else (empty, spaces, exponent notation, three decimals, "+1", ".5", non-strings) throws RangeError. Results must be exact.
- formatAmount(cents): safe integer cents to a string with exactly two decimals ("-0.05", "1234.50"). Non-safe-integers throw RangeError.
- splitEven(totalCents, n): n equal parts as integer cents that sum exactly to totalCents. Extra cents go to the earliest parts. totalCents is a non-negative safe integer, n a positive integer; otherwise RangeError.
- allocate(totalCents, weights): proportional allocation by the largest-remainder method. Each part starts at floor(total * w / sum(weights)); the leftover cents go one each to the parts with the largest exact remainders, ties broken by lower index. Parts with weight 0 get 0. weights are non-negative safe integers with a positive sum; totalCents a non-negative safe integer; otherwise RangeError. The result must sum exactly to totalCents, including for large totals where total * w exceeds 2^53.
- totalOf(texts): sum of parseAmount over an array of amount strings, as exact integer cents.

Constraints: all arithmetic on money must be exact (integer minor units; BigInt is fine where intermediate products can exceed 2^53). Do not change the API, the tests, or any other file. Do not install dependencies.

Run node --test public.test.cjs. Hidden evaluation checks conservation on many inputs, remainder tie-breaking, large totals and input validation.
